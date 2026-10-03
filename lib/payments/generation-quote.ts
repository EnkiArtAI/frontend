/**
 * Shared quote computation for generation payments (backlog #2).
 *
 * Loads everything the split needs from the server side ONLY — prompt price
 * and artist wallet from the DB, model cost from server pricing. Used by the
 * intent endpoint; the read-only quote endpoint can adopt it in a follow-up
 * so the two paths can never drift apart.
 *
 * Returns a discriminated result instead of throwing on expected states so
 * routes map each case to the right HTTP status without string matching.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PRICING_POLICY,
  UnknownModelError,
  computeGenerationSplit,
  getModelCostMicro,
  usdToMicro,
  type GenerationSplit,
} from "@/lib/payments/generation-pricing";
import {
  applyRuleToSplit,
  resolvePricingRule,
  type AppliedRule,
} from "@/lib/payments/pricing-rules";

export interface QuoteInput {
  /** Absent for the buyer's own prompt: no artist, so no artist leg. */
  promptId?: string;
  modelFamily: string;
  resolution?: "1K" | "2K" | "4K";
  /** Boost = the vendor-direct route; its REAL cost prices the model leg. */
  boost?: boolean;
  /** gpt quality lever — feeds the boost route's price where the model has one. */
  quality?: "low" | "medium" | "high";
  /** requireAuth's userId (wallet or users.id) — enables DB pricing rules. */
  buyer?: string;
}

export type QuoteResult =
  | {
      ok: true;
      /** null for free prompts — the split then has no artist leg. */
      artistWallet: string | null;
      split: GenerationSplit;
      /** DB pricing rule that discounted this quote, if any. */
      appliedRule: AppliedRule | null;
    }
  | { ok: false; status: 400 | 404 | 422 | 500; error: string };

export async function computeQuote(
  supabase: SupabaseClient,
  { promptId, modelFamily, resolution, boost, quality, buyer }: QuoteInput,
): Promise<QuoteResult> {
  // 1. Prompt price comes from the DB — never from the client.
  //    Live schema (verified 2026-07-12): prompts has creator_id +
  //    price_usd_cents — NOT user_id/price as older code assumed.
  //    No promptId means the buyer's own prompt: nothing to look up, no artist.
  let prompt: {
    price_usd_cents: number | null;
    creator_id: string | null;
    prompt_type: string | null;
    is_free_showcase: boolean | null;
  } | null = null;
  if (promptId) {
    const { data, error: promptError } = await supabase
      .from("prompts")
      .select("id, price_usd_cents, creator_id, prompt_type, is_free_showcase")
      .eq("id", promptId)
      .maybeSingle();
    if (promptError) {
      console.error("[payments/quote] prompt lookup failed:", promptError.message);
      return { ok: false, status: 500, error: "Failed to load prompt" };
    }
    if (!data) {
      return { ok: false, status: 404, error: "Prompt not found" };
    }
    prompt = data;
  }

  const isFree =
    !prompt ||
    prompt.prompt_type === "showcase" ||
    prompt.prompt_type === "free-prompt" ||
    prompt.is_free_showcase === true;
  const priceCents = typeof prompt?.price_usd_cents === "number" ? prompt.price_usd_cents : 0;
  const artistPriceMicro = isFree ? 0 : usdToMicro(priceCents / 100);

  // 2. Model cost comes from server-side pricing — never from the client.
  let modelCostMicro: number;
  try {
    modelCostMicro = getModelCostMicro(modelFamily, resolution, { boost, quality });
    // Every paid prompt is checked before generating; the buyer pays the check.
    modelCostMicro += PRICING_POLICY.extractionCheckMicro;
  } catch (error) {
    if (error instanceof UnknownModelError) {
      return { ok: false, status: 400, error: error.message };
    }
    throw error;
  }

  // 3. Artist payout wallet comes from the DB — never from the client.
  //    Live schema fix (2026-07-12): users.wallet_address does NOT exist —
  //    the creator's payout wallet is their newest live Solana entry in
  //    user_wallets (payments run on Solana only).
  //    Paid prompts without a configured artist wallet cannot be quoted:
  //    the split has nowhere to send the artist share.
  let artistWallet: string | null = null;
  if (artistPriceMicro > 0) {
    if (!prompt?.creator_id) {
      return { ok: false, status: 422, error: "Prompt has no associated creator" };
    }
    const { data: wallets, error: creatorError } = await supabase
      .from("user_wallets")
      .select("address")
      .eq("user_id", prompt.creator_id)
      .eq("chain_family", "solana")
      .is("removed_at", null)
      .limit(1);
    if (creatorError) {
      console.error("[payments/quote] creator wallet lookup failed:", creatorError.message);
      return { ok: false, status: 500, error: "Failed to load creator" };
    }
    artistWallet = wallets?.[0]?.address ?? null;
    if (!artistWallet || artistWallet === "legacy-unbound") {
      return {
        ok: false,
        status: 422,
        error: "Artist payout wallet not configured for this prompt",
      };
    }
    // A real base58 Solana pubkey always contains uppercase chars; a non-0x
    // all-lowercase address is a corrupted legacy row (an earlier bug
    // lowercased Solana wallets) that base58-decodes to the WRONG key. Refuse
    // to build a payable intent against it rather than pay a wallet nobody
    // controls. (This guard existed only on the read-only /quote route; the
    // /intent route persists money and reaches computeQuote, so it belongs
    // here.)
    if (!artistWallet.startsWith("0x") && artistWallet === artistWallet.toLowerCase()) {
      return {
        ok: false,
        status: 422,
        error: "Artist payout wallet must be re-linked before this prompt can sell",
      };
    }
  }

  let split = computeGenerationSplit(artistPriceMicro, modelCostMicro);

  // 4. DB pricing rules (discount campaigns) — best match, never touches the
  //    artist share. Applied here so quote and intent can't disagree.
  let appliedRule: AppliedRule | null = null;
  if (buyer) {
    appliedRule = await resolvePricingRule(supabase, { buyerWalletOrId: buyer, modelFamily, promptId });
    if (appliedRule) split = applyRuleToSplit(split, appliedRule);
  }

  return { ok: true, artistWallet, split, appliedRule };
}
