import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { apiPricePerImage, apiBoostPricePerImage, geminiDirectPricePerImage } from "@/lib/pricing";
import { getModelCostMicro } from "@/lib/payments/generation-pricing";
import { driftOf } from "@/lib/generation/price-drift";
import { maxTier } from "@/lib/generation/resolution";
import { imageTokenRate } from "@/backend/services/gemini-image-generation";
import { toEditModel } from "@/backend/services/wavespeed-image-generation";

/**
 * Nano Banana 2 in the existing system: one price per size, from the host that
 * runs first at that size (WaveSpeed Fast at 2K/4K, Google direct at 1K, where
 * Fast has no tier). Boost and every Google bill are held to Google's price.
 */
describe("Nano Banana 2", () => {
  it("is charged the first host's price per size, 1K included", () => {
    expect(apiPricePerImage("nano-banana-2", "1K")).toBe(0.0913);
    expect(apiPricePerImage("nano-banana-2", "1k")).toBe(0.0913);
    expect(apiPricePerImage("nano-banana-2", "2K")).toBe(0.045);
    expect(apiPricePerImage("nano-banana-2", "4K")).toBe(0.05);
    expect(getModelCostMicro("nano-banana-2", "2K")).toBe(45_000);
  });

  it("is charged Google direct's price on boost", () => {
    expect(apiBoostPricePerImage("nano-banana-2", "1K")).toBe(0.0913);
    expect(apiBoostPricePerImage("nano-banana-2", "2K")).toBe(0.1251);
    expect(apiBoostPricePerImage("nano-banana-2", "4K")).toBe(0.1763);
    expect(getModelCostMicro("nano-banana-2", "4K", { boost: true })).toBe(176_300);
  });

  it("leaves the other models' prices as they were", () => {
    expect(apiPricePerImage("nano-banana-pro", "1K")).toBe(0.1476);
    expect(apiBoostPricePerImage("nano-banana-pro", "1K")).toBe(0.1476);
    expect(apiBoostPricePerImage("nano-banana-pro", "4K")).toBe(0.2525);
    expect(apiBoostPricePerImage("gpt-image-2", "2K", "high")).toBe(0.428);
    expect(geminiDirectPricePerImage("gpt-image-2", "2K")).toBeNull();
    expect(geminiDirectPricePerImage("constructor", "2K")).toBeNull();
  });

  it("holds a Google bill to Google's price, not to Fast's", () => {
    expect(driftOf({ provider: "gemini", modelFamily: "nano-banana-2", resolution: "2K", observedUsd: 0.1251 }).drifted).toBe(false);
    expect(driftOf({ provider: "gemini", modelFamily: "nano-banana-2", resolution: "1K", observedUsd: 0.0913 }).drifted).toBe(false);
    expect(driftOf({ provider: "gemini", modelFamily: "nano-banana-2", resolution: "4K", observedUsd: 0.2 }).drifted).toBe(true);
    // A host that is not Google is still held to the table.
    expect(driftOf({ provider: "openai", modelFamily: "gpt-image-2", resolution: "2K", quality: "medium", observedUsd: 0.107 }).drifted).toBe(false);
  });

  it("renders up to 4K on every route it has", () => {
    expect(maxTier("gemini", "gemini-3.1-flash-image")).toBe("4K");
    for (const m of ["text-to-image", "edit", "text-to-image-fast", "edit-fast"]) {
      expect(maxTier("wavespeed", `google/nano-banana-2/${m}`)).toBe("4K");
    }
    expect(maxTier("gemini", "gemini-3.1-flash-image-preview")).toBe("1K");
    expect(maxTier("wavespeed", "google/nano-banana-2/text-to-image-faster")).toBe("1K");
  });

  it("is sent the size it was paid for and billed at its own token rate on Google", () => {
    expect(imageTokenRate("gemini-3.1-flash-image")).toBe(60);
    expect(imageTokenRate("gemini-3-pro-image")).toBe(120);
    expect(imageTokenRate("gemini-3.1-flash-image-preview")).toBeNull();
    expect(imageTokenRate(undefined)).toBeNull();
    // Both the size and the bill go by that rate, in the single- and the multi-image path.
    const gemini = readSource(join(__dirname, "..", "..", "backend", "services", "gemini-image-generation.ts"));
    expect(gemini).toContain("if (imageTokenRate(model) !== null && request.imageSize) {");
    expect(gemini.split("* rate) / 1_000_000")).toHaveLength(3);
    expect(gemini).not.toContain("* 120) / 1_000_000");
  });

  it("sends reference images to Fast's own edit endpoint", () => {
    expect(toEditModel("google/nano-banana-2/text-to-image-fast")).toBe("google/nano-banana-2/edit-fast");
    expect(toEditModel("google/nano-banana-2/edit-fast")).toBe("google/nano-banana-2/edit-fast");
    expect(toEditModel("google/nano-banana-2/text-to-image")).toBe("google/nano-banana-2/edit");
    expect(toEditModel("google/nano-banana-pro/text-to-image")).toBe("google/nano-banana-pro/edit");
  });
});
