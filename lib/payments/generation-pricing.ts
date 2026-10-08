/**
 * Server-side pricing for generation payments (backlog #2 — server-built payments).
 *
 * Single source of truth for the artist / model-cost / Enki-fee split.
 * All amounts are integer micro-USDC (1 USDC = 1_000_000 micro) so the split
 * math is exact — no floats past the input-conversion boundary.
 *
 * ─── POLICY KNOBS ───────────────────────────────────────────────────────────
 * Pending final confirmation from Kev. To change the fee policy, edit ONLY
 * `PRICING_POLICY` below — every quote and (later) transaction build follows it.
 *
 *   enkiFeeBps  fee rate in basis points  (1000 = 10%)
 *   feeBase     what the fee is computed on:
 *                 "subtotal"  → artist price + model cost
 *                 "modelCost" → model cost only
 *   feeMode     who bears the fee:
 *                 "addOn"            → buyer pays fee on top; artist receives
 *                                      their full listed price
 *                 "deductFromArtist" → buyer pays listed price + model cost;
 *                                      fee comes out of the artist share
 * ────────────────────────────────────────────────────────────────────────────
 */
import {
  MODEL_IMAGE_PRICING,
  apiBoostPricePerImage,
  apiPricePerImage,
} from "@/lib/pricing";

export type FeeBase = "subtotal" | "modelCost";
export type FeeMode = "addOn" | "deductFromArtist";

export const PRICING_POLICY: {
  enkiFeeBps: number;
  feeBase: FeeBase;
  feeMode: FeeMode;
  quoteTtlSeconds: number;
  networkFeeMicro: number;
  extractionCheckMicro: number;
  imageCheckMicro: number;
} = {
  enkiFeeBps: 1000,
  feeBase: "subtotal",
  feeMode: "addOn",
  quoteTtlSeconds: 300,
  /**
   * The Solana network cost of one paid generation. ZERO since 2026-09-05
   * (Kev: "i want to charge just 10% on top of the API call") — Enki carries
   * the chain cost itself again, which is exactly what ToS §4's "currently
   * paid by Enki" states. Measured cost is ~25-30k lamports per generation
   * (nonce create ~10k, close ~5k, the payment ~10-15k, base fee
   * 5k/signature) ≈ $0.002 at SOL $75; the 10% fee absorbs it.
   *
   * Kept as a knob (and carried through splitToBreakdown) so passing it on
   * again is a one-number change that the checkout displays automatically.
   */
  networkFeeMicro: 0,
  /**
   * The prompt check before every paid generation (lib/moderation/
   * prompt-check), passed on to the buyer (Kev, 2026-10-02: "den openAI
   * checker können wir ruhig auch als kosten dem kunden auferlegen"). One
   * gpt-6-luna call is about $0.000055 at 500 tokens in and 10 out; $0.0001
   * per image covers a longer answer and EU processing. Part of the model
   * cost, so the fee applies to it like to the rest of the API bill.
   */
  extractionCheckMicro: 100,
  /**
   * The image check of every image a paid generation takes in or puts out
   * (lib/moderation/image-check): omni-moderation plus gpt-6-luna at high
   * detail, about $0.00016 an image (calibration, 2026-10-08), rounded up to
   * $0.0002. The buyer pays it on every paid render, a free prompt's too:
   * free only means no artist fee (Kev, 2026-10-08). Part of the model cost,
   * like the prompt check.
   */
  imageCheckMicro: 200,
};

export const MICRO_PER_USDC = 1_000_000;

/** Convert a USD decimal amount to integer micro-USDC. */
export function usdToMicro(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`Invalid USD amount: ${usd}`);
  }
  return Math.round(usd * MICRO_PER_USDC);
}

/**
 * Model cost in micro-USDC for one image.
 *
 * Source is currently the published provider rates in `lib/pricing.ts`
 * (declared there as the single source of truth for generation pricing).
 * When `models.price` units in the DB are confirmed, swap the body of this
 * function to the DB lookup — callers only ever see micro-USDC.
 */
/**
 * The model leg a buyer pays for one image: the host's price, the prompt
 * check, and the image check of the result and of each reference image sent
 * along. getModelCostMicro stays the raw host cost.
 */
export function modelLegMicro(
  modelFamily: string,
  resolution: string | undefined,
  opts?: { boost?: boolean; quality?: "low" | "medium" | "high"; references?: number },
): number {
  return (
    getModelCostMicro(modelFamily, resolution, opts) +
    PRICING_POLICY.extractionCheckMicro +
    PRICING_POLICY.imageCheckMicro * (1 + (opts?.references ?? 0))
  );
}

export function getModelCostMicro(
  modelFamily: string,
  resolution: string | undefined,
  opts?: { boost?: boolean; quality?: "low" | "medium" | "high" },
): number {
  const tiers = MODEL_IMAGE_PRICING[modelFamily];
  if (!tiers) {
    throw new UnknownModelError(modelFamily);
  }
  /* Boost swaps the ROUTE the image runs on, so the cost leg is the boost
     route's REAL per-image price — never a flat multiplier (Kev,
     2026-08-23). Since 2026-08-24 quality prices the NORMAL path too: gpt
     routes by quality (OpenAI below high, WaveSpeed at high), so the charged
     leg is always the cost of the host that will actually run. */
  if (opts?.boost) {
    return usdToMicro(apiBoostPricePerImage(modelFamily, resolution ?? "2K", opts.quality));
  }
  return usdToMicro(apiPricePerImage(modelFamily, resolution ?? "2K", opts?.quality));
}

export class UnknownModelError extends Error {
  constructor(modelFamily: string) {
    super(`Unknown model family: ${modelFamily}`);
    this.name = "UnknownModelError";
  }
}

export interface GenerationSplit {
  /** Goes directly to the artist wallet. */
  artistAmountMicro: number;
  /** Raw provider cost component (informational; part of the Enki leg). */
  modelCostMicro: number;
  /**
   * Enki fee component (informational; part of the Enki leg). INCLUDES the
   * network fee — the DB rows and the leg invariant (artist + model + fee =
   * total) know only these three components, so the network fee lives inside
   * this one rather than growing every schema and assertion around it.
   */
  enkiFeeMicro: number;
  /**
   * The network-cost part of enkiFeeMicro, carried separately so the checkout
   * can SHOW it (ToS §4: a passed-on network fee must be displayed before the
   * order is confirmed). Never larger than enkiFeeMicro.
   */
  networkFeeMicro: number;
  /** Second transfer: model cost + fee → Enki wallet. */
  enkiTotalMicro: number;
  /** What the buyer pays in total (artist leg + Enki leg). */
  totalMicro: number;
}

/**
 * Compute the two-transfer split for one generation.
 *
 * Invariant: artistAmountMicro + enkiTotalMicro === totalMicro, always.
 * Fee rounding is floor (fractional micro goes to the buyer's favor).
 */
export function computeGenerationSplit(
  artistPriceMicro: number,
  modelCostMicro: number,
): GenerationSplit {
  assertMicro("artistPriceMicro", artistPriceMicro);
  assertMicro("modelCostMicro", modelCostMicro);

  const feeBaseMicro =
    PRICING_POLICY.feeBase === "subtotal"
      ? artistPriceMicro + modelCostMicro
      : modelCostMicro;
  const networkFeeMicro = PRICING_POLICY.networkFeeMicro;
  const enkiFeeMicro =
    Math.floor((feeBaseMicro * PRICING_POLICY.enkiFeeBps) / 10_000) + networkFeeMicro;

  let artistAmountMicro: number;
  if (PRICING_POLICY.feeMode === "addOn") {
    artistAmountMicro = artistPriceMicro;
  } else {
    artistAmountMicro = artistPriceMicro - enkiFeeMicro;
    if (artistAmountMicro < 0) {
      throw new Error(
        `Fee (${enkiFeeMicro}) exceeds artist price (${artistPriceMicro}) under deductFromArtist policy`,
      );
    }
  }

  const enkiTotalMicro = modelCostMicro + enkiFeeMicro;
  const totalMicro = artistAmountMicro + enkiTotalMicro;

  return {
    artistAmountMicro,
    modelCostMicro,
    enkiFeeMicro,
    networkFeeMicro,
    enkiTotalMicro,
    totalMicro,
  };
}

function assertMicro(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (micro-USDC), got: ${value}`);
  }
}

/** Serialize a split for API responses (amounts as strings, like on-chain u64s). */
export function splitToBreakdown(split: GenerationSplit) {
  return {
    artistAmount: String(split.artistAmountMicro),
    modelCost: String(split.modelCostMicro),
    enkiFee: String(split.enkiFeeMicro),
    // Broken out of enkiFee so the checkout can show it — ToS §4 conditions
    // passing the network fee on upon displaying it before the order.
    networkFee: String(split.networkFeeMicro),
    enkiTotal: String(split.enkiTotalMicro),
    totalAmount: String(split.totalMicro),
    currency: "USDC" as const,
    decimals: 6,
    feePolicy: {
      feeBps: PRICING_POLICY.enkiFeeBps,
      feeBase: PRICING_POLICY.feeBase,
      feeMode: PRICING_POLICY.feeMode,
    },
  };
}
