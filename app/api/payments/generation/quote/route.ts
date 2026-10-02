/**
 * POST /api/payments/generation/quote
 *
 * First half of server-built payments (backlog #2). The client sends ONLY
 * identifiers — never a price, amount, or destination:
 *
 *   Body: { promptId?, modelId, resolution, quality?, boost?, referenceImageCount? }
 *   (lib/payments/generation-settings.ts: the sum of settings, priced once)
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
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { requireAuth, checkRateLimit } from "@/lib/auth";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { PRICING_POLICY, splitToBreakdown } from "@/lib/payments/generation-pricing";
import { computeQuote } from "@/lib/payments/generation-quote";
import { settingsSchema, resolvePaidSettings } from "@/lib/payments/generation-settings";


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
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.issues },
      { status: 400 },
    );
  }
  const supabase = getSupabaseServerClient();
  const resolved = await resolvePaidSettings(supabase, parsed.data);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  const { settings } = resolved;
  const promptId = parsed.data.promptId;

  // Shared with the intent route (lib/payments/generation-quote.ts) so the two
  // paths can never drift apart — including DB pricing rules (discounts).
  const quote = await computeQuote(supabase, {
    promptId,
    modelFamily: settings.modelFamily,
    resolution: settings.resolution,
    boost: settings.boost,
    quality: settings.quality ?? undefined,
    buyer: authUser.userId,
  });
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
      ...settings,
      buyerWallet: authUser.walletAddress,
      artistWallet,
      expiresAt,
      breakdown: splitToBreakdown(split),
      appliedRule: appliedRule ? { name: appliedRule.name, effect: appliedRule.effect } : null,
    },
  });
}
