import { describe, it, expect } from "vitest";
import { quoteBatch, quoteRequest, quoteIn, MAX_QUOTES } from "../quote-batch";
import type { RenderPicks } from "../generate-checks";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { GenerationQuote } from "@/lib/generation-checkout";

const model = (o: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
  id: "m-pro", name: "Nano Banana Pro", price: 0.1, mediaType: "image", supportsQuality: false, maxResolution: "4K",
  ratios: ["1:1", "4:5"], boostAvailable: true, boostTiers: ["2K", "4K"], maxRefs: 14, free: false, ...o,
});
const pro = model();
const gpt = model({ id: "m-gpt", name: "GPT Image", supportsQuality: true, maxResolution: "2K", boostAvailable: false, boostTiers: [] });
const nb2 = model({ id: "m-nb2", name: "Nano Banana 2", boostTiers: ["2K"] });
const flux = model({ id: "m-flux", name: "Flux", free: true, maxResolution: "2K" });
const video = model({ id: "m-vid", name: "Seedance", mediaType: "video" });
const picks: RenderPicks = { ratio: "4:5", resolution: "4K", quality: "high", boost: true };

describe("quoteRequest", () => {
  it("asks exactly what Generate charges, references counted, never a promptId", () => {
    const q = quoteRequest(pro, picks, 3);
    expect(q).toEqual({ modelId: "m-pro", resolution: "4K", quality: undefined, boost: true, referenceImageCount: 3 });
    expect(q).not.toHaveProperty("promptId");
  });

  it("asks nothing for the free host or without a model", () => {
    expect(quoteRequest(flux, picks, 0)).toBeNull();
    expect(quoteRequest(undefined, picks, 0)).toBeNull();
  });

  it("masks per model: its tier ceiling, quality only where it has one, boost only at a tier with a faster host", () => {
    expect(quoteRequest(gpt, picks, 0)).toEqual({ modelId: "m-gpt", resolution: "2K", quality: "high", boost: false, referenceImageCount: 0 });
    expect(quoteRequest(nb2, picks, 0)?.boost).toBe(false);
    expect(quoteRequest(nb2, { ...picks, resolution: "2K" }, 0)?.boost).toBe(true);
    expect(quoteRequest(model({ boostAvailable: false }), picks, 0)?.boost).toBe(false);
  });
});

describe("quoteBatch", () => {
  it("holds the chip, the test model's tiers and qualities, then every image model; no free or video model, no duplicate", () => {
    const batch = quoteBatch([flux, pro, gpt, video, nb2], gpt, picks, 2);
    const key = (q: (typeof batch)[number]) => `${q.modelId} ${q.resolution} ${q.quality ?? "-"} ${q.boost}`;
    expect(batch.map(key)).toEqual([
      "m-gpt 2K high false",
      "m-gpt 1K high false",
      "m-gpt 2K low false",
      "m-gpt 2K medium false",
      "m-pro 4K - true",
      "m-nb2 4K - false",
    ]);
    expect(batch.every((q) => q.referenceImageCount === 2 && !("promptId" in q))).toBe(true);
  });

  it("asks a test model without quality for its tiers only", () => {
    expect(quoteBatch([], pro, picks, 0).map((q) => q.resolution)).toEqual(["4K", "1K", "2K"]);
    expect(quoteBatch([pro], undefined, picks, 0)).toHaveLength(1);
  });

  it("never asks more than the route takes, and keeps the chip", () => {
    const many = Array.from({ length: 30 }, (_, n) => model({ id: `m${n}` }));
    const batch = quoteBatch(many, gpt, picks, 0);
    expect(MAX_QUOTES).toBe(24);
    expect(batch).toHaveLength(24);
    expect(batch[0].modelId).toBe("m-gpt");
  });
});

describe("quoteIn", () => {
  it("finds a request's answer by value; null when it was not asked", () => {
    const batch = quoteBatch([pro, gpt], gpt, picks, 0);
    const answers = batch.map((_, i) => ({ totalMicro: i } as GenerationQuote));
    expect(quoteIn(batch, answers, quoteRequest(pro, picks, 0))?.totalMicro).toBe(4);
    expect(quoteIn(batch, answers, quoteRequest(gpt, { ...picks, resolution: "1K" }, 0))?.totalMicro).toBe(1);
    expect(quoteIn(batch, answers, quoteRequest(pro, picks, 1))).toBeNull();
    expect(quoteIn(batch, answers, null)).toBeNull();
    expect(quoteIn(batch, batch.map(() => null), quoteRequest(pro, picks, 0))).toBeNull();
  });
});
