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
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { authRefusal, requireAuth, checkRateLimit } from "@/lib/auth";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { PRICING_POLICY, splitToBreakdown } from "@/lib/payments/generation-pricing";
import { computeQuote } from "@/lib/payments/generation-quote";
import { settingsSchema, resolvePaidSettings, type SettingsInput } from "@/lib/payments/generation-settings";

/* Every price a picker shows is a server quote (Kev, 2026-10-02: "ich brauche
   safe überall den server-quote"). A picker prices all its options at once,
   so it asks once: one request, one rate-limit slot, up to 24 quotes. */
const batchSchema = z.object({ items: z.array(settingsSchema).min(1).max(24) });

/** One quote, or why there is none: the same answer for a single request and for each batch item. */
async function quoteOne(
  supabase: SupabaseClient,
  input: SettingsInput,
  user: { userId: string; walletAddress: string; sessionToken: string | null },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const resolved = await resolvePaidSettings(supabase, input);
  if (!resolved.ok) return { status: resolved.status, body: { error: resolved.error } };
  const { settings } = resolved;
  const promptId = input.promptId;

  // Shared with the intent route (lib/payments/generation-quote.ts) so the two
  // paths can never drift apart — including DB pricing rules (discounts).
  const quote = await computeQuote(supabase, {
    promptId,
    modelFamily: settings.modelFamily,
    resolution: settings.resolution,
    boost: settings.boost,
    quality: settings.quality ?? undefined,
    buyer: user.userId,
    sessionToken: user.sessionToken,
  });
  if (!quote.ok) return { status: quote.status, body: { error: quote.error } };
  const { artistWallet, split, appliedRule } = quote;

  const expiresAt = new Date(
    Date.now() + PRICING_POLICY.quoteTtlSeconds * 1000,
  ).toISOString();

  return {
    status: 200,
    body: {
      quote: {
        promptId: promptId ?? null,
        ...settings,
        buyerWallet: user.walletAddress,
        artistWallet,
        expiresAt,
        breakdown: splitToBreakdown(split),
        appliedRule: appliedRule ? { name: appliedRule.name, effect: appliedRule.effect } : null,
      },
    },
  };
}

export async function POST(req: NextRequest) {
  // 60 payments/min per user (Kev, 2026-07-08 — dApp-friendly); IP cap above
  // it so one NAT/office IP with several users is never the binding limit.
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "payments:quote:ip"), 120, 60_000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  let authUser;
  try {
    authUser = { ...(await requireAuth(req)), sessionToken: req.headers.get("X-Session-Token") };
  } catch (e) {
    return authRefusal(e);
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
  const supabase = getSupabaseServerClient();

  const batch = batchSchema.safeParse(body);
  if (batch.success) {
    const results = await Promise.all(batch.data.items.map((item) => quoteOne(supabase, item, authUser)));
    return NextResponse.json({
      quotes: results.map((r) => (r.status === 200 ? r.body.quote : { error: r.body.error })),
    });
  }

  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.issues },
      { status: 400 },
    );
  }
  const one = await quoteOne(supabase, parsed.data, authUser);
  return NextResponse.json(one.body, { status: one.status });
}
