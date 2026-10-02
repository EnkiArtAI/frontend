/**
 * POST /api/payments/generation/quote
 *
 * First half of server-built payments (backlog #2). The client sends ONLY
 * identifiers — never a price, amount, or destination:
 *
 *   Body: { promptId?: string, modelFamily: string, resolution?: "1K" | "2K" | "4K" }
 *
 * The server loads the prompt price and artist wallet from its own DB,
 * takes the model cost from server-side pricing, and returns the full
 * split so the user can see exactly what they'd pay:
 *
 *   { quote: { promptId, modelFamily, resolution, expiresAt,
 *              artistWallet, breakdown: { artistAmount, modelCost, enkiFee,
 *              enkiTotal, totalAmount, currency, decimals, feePolicy } } }
 *
 * Amounts are integer micro-USDC serialized as strings.
 *
 * This endpoint is read-only. The companion confirm endpoint (next step)
 * will persist a payment intent (see migrations/generation_payment_intents.sql),
 * build the atomic two-transfer Solana tx server-side; the buyer signs it
 * and broadcast — replacing the client-built x402 flow and retiring
 * in their own wallet.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { requireAuth, checkRateLimit } from "@/lib/auth";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { PRICING_POLICY, splitToBreakdown } from "@/lib/payments/generation-pricing";
import { computeQuote } from "@/lib/payments/generation-quote";

const quoteSchema = z.object({
  /* Absent when buyers generate from their own prompt (the editors). */
  promptId: z.string().min(1).max(128).optional(),
  modelFamily: z.string().min(1).max(64),
  /* 1K joined 2026-08-22 (Kev: "warum keine 1K generierungen"). It is
     priced as 2K — toResolutionTier maps it, the provider fact being that
     both hosts charge 1K and 2K identically — so the schema admitting it
     cannot underprice anything. */
  resolution: z.enum(["1K", "2K", "4K"]).optional(),
  /* Boost prices the model leg at the vendor-direct route's REAL cost
     (quality-aware for gpt) — see getModelCostMicro. Optional: absent means
     the normal ladder, so existing clients quote unchanged. */
  boost: z.boolean().optional(),
  quality: z.enum(["low", "medium", "high"]).optional(),
});

export async function POST(req: NextRequest) {
  // 60 payments/min per user (Kev, 2026-07-08 — dApp-friendly); IP cap above
  // it so one NAT/office IP with several users is never the binding limit.
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "payments:quote:ip"), 120, 60_000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  let authUser;
  try {
    authUser = await requireAuth(req);
  } catch {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  if (!checkRateLimit(authUser.userId, "payments:quote", 60, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const parsed = quoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.issues },
      { status: 400 },
    );
  }
  const { promptId, modelFamily, resolution } = parsed.data;

  const supabase = getSupabaseServerClient();

  // Shared with the intent route (lib/payments/generation-quote.ts) so the two
  // paths can never drift apart — including DB pricing rules (discounts).
  const quote = await computeQuote(supabase, { ...parsed.data, buyer: authUser.userId });
  if (!quote.ok) {
    return NextResponse.json({ error: quote.error }, { status: quote.status });
  }
  const { artistWallet, split, appliedRule } = quote;

  const expiresAt = new Date(
    Date.now() + PRICING_POLICY.quoteTtlSeconds * 1000,
  ).toISOString();

  return NextResponse.json({
    quote: {
      promptId: promptId ?? null,
      modelFamily,
      resolution: resolution ?? "2K",
      buyerWallet: authUser.walletAddress,
      artistWallet,
      expiresAt,
      breakdown: splitToBreakdown(split),
      appliedRule: appliedRule ? { name: appliedRule.name, effect: appliedRule.effect } : null,
    },
  });
}
