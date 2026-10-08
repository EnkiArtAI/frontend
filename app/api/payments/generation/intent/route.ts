/**
 * POST /api/payments/generation/intent
 *
 * Server-built payments (backlog #2), step 2: persist the intent. The client
 * sends ONLY identifiers — never a price, amount, or destination:
 *
 *   Body: { promptId?, modelId, resolution, quality?, boost?, referenceImageCount? }
 *   (lib/payments/generation-settings.ts: the sum of settings, priced once)
 *
 * The server recomputes the full split from its own DB and pricing (it never
 * trusts an earlier quote response), stores it as a payment intent with
 * status "quoted" and a TTL, and returns the intent id with the breakdown:
 *
 *   { intent: { id, promptId, modelFamily, resolution, buyerWallet,
 *               artistWallet, expiresAt, breakdown } }
 *
 * The companion pay endpoint (next step) consumes the intent with an atomic
 * quoted→building transition (single conditional UPDATE — see
 * docs/PAYMENT-SECURITY-PATTERNS.md #2), builds the atomic multi-transfer
 * Solana tx server-side; the buyer signs it in their own wallet.
 *
 * Requires migrations/generation_payment_intents.sql to be applied.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { authRefusal, requireAuth, checkRateLimit } from "@/lib/auth";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { PRICING_POLICY, splitToBreakdown } from "@/lib/payments/generation-pricing";
import { computeQuote } from "@/lib/payments/generation-quote";
import { settingsSchema, resolvePaidSettings } from "@/lib/payments/generation-settings";
import { refusalBody } from "@/lib/db-error";

export async function POST(req: NextRequest) {
  // 60 payments/min per user (Kev, 2026-07-08 — dApp-friendly). The IP cap
  // sits above it so one NAT/office IP with several users is never throttled
  // below the per-user limit.
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "payments:intent:ip"), 120, 60_000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  let authUser;
  try {
    authUser = await requireAuth(req);
  } catch (e) {
    return authRefusal(e);
  }

  if (!checkRateLimit(authUser.userId, "payments:intent", 60, 60_000)) {
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
  if (!resolved.ok) return NextResponse.json(refusalBody(resolved), { status: resolved.status });
  const { settings } = resolved;
  const promptId = parsed.data.promptId;

  const quote = await computeQuote(supabase, {
    promptId,
    modelFamily: settings.modelFamily,
    resolution: settings.resolution,
    boost: settings.boost,
    quality: settings.quality ?? undefined,
    buyer: authUser.userId,
    sessionToken: req.headers.get("X-Session-Token"),
  });
  if (!quote.ok) {
    return NextResponse.json(refusalBody(quote), { status: quote.status });
  }
  const { artistWallet, split, appliedRule } = quote;

  const expiresAt = new Date(
    Date.now() + PRICING_POLICY.quoteTtlSeconds * 1000,
  ).toISOString();

  // buyer_wallet comes from the session, never from the client. NOTE for the
  // pay step: session wallets are stored lowercased (auth_sessions), which is
  // lossy for base58 — resolve the case-exact address from user_wallets
  // before building the on-chain transfer.
  const { data: intent, error: insertError } = await supabase
    .from("generation_payment_intents")
    .insert({
      buyer_wallet: authUser.walletAddress,
      prompt_id: promptId ?? null,
      // The sum of settings: /api/generate-image runs exactly these.
      model_id: settings.modelId,
      model_family: settings.modelFamily,
      resolution: settings.resolution,
      quality: settings.quality,
      boost: settings.boost,
      reference_image_count: settings.referenceImageCount,
      artist_wallet: artistWallet,
      artist_amount_micro: split.artistAmountMicro,
      model_cost_micro: split.modelCostMicro,
      enki_fee_micro: split.enkiFeeMicro,
      total_micro: split.totalMicro,
      fee_bps: PRICING_POLICY.enkiFeeBps,
      fee_base: PRICING_POLICY.feeBase,
      fee_mode: PRICING_POLICY.feeMode,
      expires_at: expiresAt,
      applied_rule_id: appliedRule?.id ?? null,
    })
    .select("id")
    .single();
  if (insertError || !intent) {
    console.error("[payments/intent] insert failed:", insertError?.message);
    return NextResponse.json({ error: "Failed to create payment intent" }, { status: 500 });
  }

  // Free-use quotas are NOT counted here: they burn only when the generation
  // is actually delivered — see fulfillGenerationIntent (Kev, 2026-07-12:
  // cancellable queue; a cancelled generation must not consume a free use).

  return NextResponse.json({
    intent: {
      id: intent.id,
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
