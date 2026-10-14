import { describe, it, expect } from "vitest";
import {
  apiBoostPricePerImage,
  apiPricePerImage,
  MODEL_IMAGE_PRICING,
  effectiveQuality,
} from "@/lib/pricing";
import { getModelCostMicro } from "@/lib/payments/generation-pricing";

/**
 * Prices = the REAL cost of the host that will run (Kev: "ECHTE KOSTEN").
 * gpt-image-2 routes BY QUALITY since 2026-08-24 — OpenAI direct below high,
 * WaveSpeed flat at high — and has no boost any more. The exact-number
 * assertions are the tripwire for the day a table row moves unnoticed.
 * OpenAI cells measured 2026-08-24 (metered bench, billed output tokens).
 */
describe("apiPricePerImage — gpt runs OpenAI direct on every quality", () => {
  it("low and medium: the measured OpenAI cells", () => {
    expect(apiPricePerImage("gpt-image-2", "2K", "low")).toBe(0.012);
    expect(apiPricePerImage("gpt-image-2", "4K", "low")).toBe(0.02);
    expect(apiPricePerImage("gpt-image-2", "2K", "medium")).toBe(0.107);
    expect(apiPricePerImage("gpt-image-2", "4K", "medium")).toBe(0.178);
  });

  it("high: OpenAI's measured cells — WaveSpeed's 2026-09-05 matrix (\$0.40/\$0.72) would have lost money against the old flat \$0.167/\$0.25", () => {
    expect(apiPricePerImage("gpt-image-2", "2K", "high")).toBe(0.428);
    expect(apiPricePerImage("gpt-image-2", "4K", "high")).toBe(0.712);
  });

  it("the ladder row (picker 'from' price, tier ratio) is the MEDIUM cell — the two tables may never drift apart", () => {
    expect(MODEL_IMAGE_PRICING["gpt-image-2"]["2K"]).toBe(apiPricePerImage("gpt-image-2", "2K", "medium"));
    expect(MODEL_IMAGE_PRICING["gpt-image-2"]["4K"]).toBe(apiPricePerImage("gpt-image-2", "4K", "medium"));
  });

  it("an unstated quality prices at the tier default the server renders with", () => {
    expect(effectiveQuality("1K")).toBe("low");
    expect(effectiveQuality("2K")).toBe("medium");
    expect(effectiveQuality("4K")).toBe("high");
    expect(apiPricePerImage("gpt-image-2", "2K")).toBe(apiPricePerImage("gpt-image-2", "2K", "medium"));
    expect(apiPricePerImage("gpt-image-2", "4K")).toBe(apiPricePerImage("gpt-image-2", "4K", "high"));
    expect(apiPricePerImage("gpt-image-2", "1K")).toBe(apiPricePerImage("gpt-image-2", "1K", "low"));
  });

  it("non-gpt models ignore quality — their hosts have no such lever", () => {
    expect(apiPricePerImage("nano-banana-pro", "2K", "high")).toBe(apiPricePerImage("nano-banana-pro", "2K"));
  });
});

describe("apiBoostPricePerImage", () => {
  it("nano boost is Gemini direct: $0.134 at 2K, $0.24 at 4K (confirmed vs the official page)", () => {
    expect(apiBoostPricePerImage("nano-banana-pro", "2K")).toBe(0.1476);
    expect(apiBoostPricePerImage("nano-banana-pro", "4K")).toBe(0.2525);
    // 1K prices as 2K everywhere (toResolutionTier), boost included.
    expect(apiBoostPricePerImage("nano-banana-pro", "1K")).toBe(0.1476);
  });

  it("gpt has NO boost: the flag answers the routed normal price (Kev, 2026-08-24)", () => {
    for (const q of ["low", "medium", "high"] as const) {
      expect(apiBoostPricePerImage("gpt-image-2", "2K", q)).toBe(apiPricePerImage("gpt-image-2", "2K", q));
      expect(apiBoostPricePerImage("gpt-image-2", "4K", q)).toBe(apiPricePerImage("gpt-image-2", "4K", q));
    }
  });

  it("a family without a price table has no price: it never borrows Nano Banana Pro's", () => {
    expect(() => apiPricePerImage("flux", "2K")).toThrow(/No price table/);
    expect(() => apiBoostPricePerImage("flux", "2K")).toThrow(/No price table/);
  });
});

describe("apiPricePerImage by quality", () => {
  it("gpt quality sets the price, and no quality means the tier default the server renders", () => {
    expect(apiPricePerImage("gpt-image-2", "2K", "high")).toBe(0.428);
    expect(apiPricePerImage("gpt-image-2", "2K", "low")).toBe(0.012);
    expect(apiPricePerImage("gpt-image-2", "4K")).toBe(0.712);
    expect(apiBoostPricePerImage("nano-banana-pro", "4K")).toBe(0.2525);
  });
});

describe("getModelCostMicro (the CHARGED leg)", () => {
  it("boost swaps the model-cost leg to the boost route, in exact micro", () => {
    expect(getModelCostMicro("nano-banana-pro", "4K", { boost: true })).toBe(252_500);
  });

  it("gpt charges the quality-routed host, boost flag or not", () => {
    expect(getModelCostMicro("gpt-image-2", "2K", { quality: "medium" })).toBe(107_000);
    expect(getModelCostMicro("gpt-image-2", "4K", { quality: "high" })).toBe(712_000);
    expect(getModelCostMicro("gpt-image-2", "4K", { boost: true, quality: "high" })).toBe(712_000);
  });

  it("no opts means the tier-default quality — matching what would render", () => {
    expect(getModelCostMicro("nano-banana-pro", "4K")).toBe(252_500);
    expect(getModelCostMicro("gpt-image-2", "2K")).toBe(107_000);
    expect(getModelCostMicro("nano-banana-pro", "4K", { boost: false })).toBe(
      getModelCostMicro("nano-banana-pro", "4K"),
    );
  });

  it("boost defaults the missing resolution to 2K, matching the quote route's default", () => {
    expect(getModelCostMicro("nano-banana-pro", undefined, { boost: true })).toBe(147_600);
  });
});
