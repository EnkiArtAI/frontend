/**
 * Per-image provider cost by model family, resolution and (for gpt) quality.
 * The server prices every generation from these (lib/payments/generation-pricing.ts);
 * what a buyer sees is the server's quote, never a total computed in the browser.
 */
import { normalizeTier } from "@/lib/generation/resolution";

export type ResolutionTier = "2K" | "4K";

/** 2K and 4K always; 1K only where the host prices it apart from 2K. */
export type PriceRow = Record<ResolutionTier, number> & { "1K"?: number };

/** Real per-image API cost (USD) by model id and resolution tier. */
export const MODEL_IMAGE_PRICING: Record<string, PriceRow> = {
  /* nano-banana-pro runs Gemini direct since 2026-09-05: WaveSpeed raised
     its 1K/2K to $0.14 while Gemini stays $0.134 (official page). */
  "nano-banana-pro": { "2K": 0.134, "4K": 0.24 },
  /* gpt-image-2 runs OpenAI direct on EVERY quality since 2026-09-05 —
     WaveSpeed dropped its flat $0.167/$0.25 for a quality matrix that would
     have lost us money at high ($0.40/$0.72 vs our $0.167/$0.25). This row
     is the MEDIUM cell (the picker's "from" price and the tier ratio); the
     charged price per quality is GPT_OPENAI below. */
  "gpt-image-2": { "2K": 0.107, "4K": 0.178 },
  /* nano-banana-2 runs WaveSpeed Fast at 2K/4K and Google direct at 1K, where
     Fast has no tier: the cheapest host per size (checked 2026-10-05). */
  "nano-banana-2": { "1K": 0.0672, "2K": 0.045, "4K": 0.05 },
};


/**
 * Normalize an arbitrary resolution string to a priced tier.
 *
 * The old body was `resolution === "4K" ? "4K" : "2K"`, which priced EVERY
 * other spelling as 2K — including the lowercase "4k" that the editor surfaces
 * send. WaveSpeed's adapter reads that same "4k" through a map that falls back
 * to '1k', so one input produced two different wrong answers: billed at 2K,
 * rendered at the smallest tier. Case is repaired here rather than defaulted,
 * and 1K is priced as 2K because Google charges the same 1120 tokens for both
 * — a real fact, not a shrug.
 */
export function toResolutionTier(resolution: string | undefined): ResolutionTier {
  const tier = normalizeTier(resolution);
  return tier === "4K" ? "4K" : "2K";
}

/** A row's price at this resolution: its own 1K cell when it has one. */
function priceAt(row: PriceRow, resolution: string | undefined): number {
  return (normalizeTier(resolution) === "1K" ? row["1K"] : undefined) ?? row[toResolutionTier(resolution)];
}

export type GptQuality = "low" | "medium" | "high";

/**
 * The quality a gpt request renders at when the caller does not say.
 * MUST mirror TIER_QUALITY in backend/services/openai-image-generation.ts —
 * the service applies this default at render time, so pricing and routing
 * applying a different one would charge for a quality that never runs.
 */
export const TIER_DEFAULT_QUALITY: Record<"1K" | "2K" | "4K", GptQuality> = {
  "1K": "low",
  "2K": "medium",
  "4K": "high",
};

/** The quality that will actually run: the caller's, or the tier default. */
export function effectiveQuality(resolution: string | undefined, quality?: string | null): GptQuality {
  if (quality === "low" || quality === "medium" || quality === "high") return quality;
  return TIER_DEFAULT_QUALITY[normalizeTier(resolution) ?? "2K"];
}

/**
 * gpt-image-2 on OpenAI DIRECT — billed as image output tokens at $30/1M
 * (official rate, confirmed 2026-08-24). Every cell MEASURED (metered
 * bench, 2026-08-24, Kev-approved) at the exact sizes our OpenAI service
 * requests — 2K = 2048x2048, 4K = 2880x2880 (its 8.29MP ceiling):
 *   low    2K  397 tok   4K   659 tok
 *   medium 2K 3568 tok   4K  5930 tok
 *   high   2K 14272 tok  4K 23719 tok
 * Rounded up to the next tenth of a cent, never down.
 */
const GPT_OPENAI: Record<GptQuality, Record<ResolutionTier, number>> = {
  low: { "2K": 0.012, "4K": 0.02 },
  medium: { "2K": 0.107, "4K": 0.178 },
  high: { "2K": 0.428, "4K": 0.712 },
};

/**
 * Published API cost (USD) for a single image at the given model, resolution
 * and (for gpt) quality.
 *
 * gpt-image-2 runs OpenAI direct on EVERY quality (Kev, 2026-09-05, after
 * WaveSpeed dropped its flat price for a quality matrix: the 2026-08-24
 * "high → WaveSpeed" split rested on a $0.167/$0.25 that no longer exists,
 * and WaveSpeed's new high cells — $0.40/$0.72 — would have lost money
 * against what we charged). Every cell here is a MEASURED OpenAI cost; the
 * remaining WaveSpeed gpt row is an outage fallback only.
 */
export function apiPricePerImage(modelId: string, resolution: string, quality?: string | null): number {
  const tier = toResolutionTier(resolution);
  if (modelId === "gpt-image-2") {
    return GPT_OPENAI[effectiveQuality(resolution, quality)][tier];
  }
  // No default: a family without a price table has no price, it does not
  // borrow Nano Banana Pro's.
  const ladder = MODEL_IMAGE_PRICING[modelId];
  if (!ladder) throw new Error(`No price table for model "${modelId}"`);
  return priceAt(ladder, resolution);
}

/**
 * Boost-route cost per image; models without a boost route answer their
 * normal price.
 *
 * nano-banana-pro boost is Gemini direct, token-based: 1120 output tokens at
 * 1K/2K and 2000 at 4K — $0.134 / $0.24. CONFIRMED against the official
 * pricing page 2026-08-24 (ai.google.dev/gemini-api/docs/pricing).
 *
 * gpt-image-2 has NO boost any more (Kev, 2026-08-24: "deaktiviere boost bei
 * gpt image 2") — quality-aware routing already runs every request on its
 * cheapest host, so a paid "faster host" stopped existing. The flag answers
 * the routed normal price.
 */
const GEMINI_DIRECT: Record<string, PriceRow> = {
  "nano-banana-pro": { "2K": 0.134, "4K": 0.24 },
  // gemini-3.1-flash-image: 1120 / 1680 / 2520 tokens at $60 per 1M (official page, 2026-10-05).
  "nano-banana-2": { "1K": 0.0672, "2K": 0.1008, "4K": 0.1512 },
};

/** Google direct's price for this model, or null when the model does not run there. */
export function geminiDirectPricePerImage(modelId: string, resolution: string): number | null {
  return Object.hasOwn(GEMINI_DIRECT, modelId) ? priceAt(GEMINI_DIRECT[modelId], resolution) : null;
}

export function apiBoostPricePerImage(
  modelId: string,
  resolution: string,
  quality?: "low" | "medium" | "high",
): number {
  return geminiDirectPricePerImage(modelId, resolution) ?? apiPricePerImage(modelId, resolution, quality);
}

