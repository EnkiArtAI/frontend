import { describe, it, expect } from "vitest";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import { defaultModel, isFreePrompt, modelOptions, refCap, refSlots } from "../models";

const model = (name: string, over: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
  id: `id-${name}`, name, price: 0.1, mediaType: "image", supportsQuality: false,
  maxResolution: "2K", ratios: ["1:1"], free: false, ...over,
});

const FLUX = model("Flux (free)", { price: 0, free: true });
const NBP = model("Nano Banana Pro");
const GPT = model("GPT-Image-2", { supportsQuality: true });
const VIDEO = model("Seedance 2.0", { mediaType: "video" });
const CATALOGUE = [FLUX, NBP, VIDEO, GPT];

describe("isFreePrompt", () => {
  it("is a free prompt, a showcase or a free showcase, as GET /api/prompts/[id] names them", () => {
    expect(isFreePrompt({ prompt_type: "free-prompt" })).toBe(true);
    expect(isFreePrompt({ prompt_type: "showcase" })).toBe(true);
    expect(isFreePrompt({ prompt_type: "paid-prompt", is_free_showcase: true })).toBe(true);
    expect(isFreePrompt({ prompt_type: "paid-prompt", is_free_showcase: false })).toBe(false);
    expect(isFreePrompt({ prompt_type: "create-now" })).toBe(false);
  });
});

describe("modelOptions", () => {
  it("offers every image generator, the free host too, in catalogue order (a free prompt, the blank composer)", () => {
    expect(modelOptions(CATALOGUE, false)).toEqual([FLUX, NBP, GPT]);
  });

  it("offers no free host on a premium prompt", () => {
    expect(modelOptions(CATALOGUE, true)).toEqual([NBP, GPT]);
  });
});

describe("defaultModel", () => {
  const pick = (over: Partial<Parameters<typeof defaultModel>[0]>) =>
    defaultModel({ catalogue: CATALOGUE, pick: "", aiModel: "Nano Banana Pro", premium: true, ...over });

  it("preselects the prompt's own model, by name or by its slug", () => {
    expect(pick({})).toBe("Nano Banana Pro");
    expect(pick({ aiModel: "gpt-image-2" })).toBe("GPT-Image-2");
  });

  it("never resets the buyer's pick", () => {
    expect(pick({ pick: "GPT-Image-2" })).toBe("GPT-Image-2");
    expect(pick({ pick: "GPT-Image-2", aiModel: null })).toBe("GPT-Image-2");
  });

  it("falls back to Nano Banana Pro when the prompt's model is not on offer or unknown", () => {
    expect(pick({ aiModel: "Flux (free)" })).toBe("Nano Banana Pro");
    expect(pick({ aiModel: "Flux (free)", premium: false })).toBe("Flux (free)");
    expect(pick({ aiModel: "Seedance 2.0" })).toBe("Nano Banana Pro");
    expect(pick({ aiModel: "Midjourney" })).toBe("Nano Banana Pro");
  });

  it("starts the blank composer, which has no prompt, on Nano Banana Pro", () => {
    expect(pick({ aiModel: undefined, premium: false })).toBe("Nano Banana Pro");
  });

  it("preselects nothing when the catalogue has no Nano Banana Pro either", () => {
    expect(pick({ catalogue: [FLUX, GPT], aiModel: "Midjourney" })).toBe("");
    expect(pick({ catalogue: [FLUX, GPT], aiModel: undefined, premium: false })).toBe("");
  });
});

describe("references", () => {
  it("refCap is the model's own limit, never above 4", () => {
    expect(refCap(undefined)).toBe(0);
    expect(refCap(model("x"))).toBe(0);
    expect(refCap(model("x", { maxRefs: 0 }))).toBe(0);
    expect(refCap(model("x", { maxRefs: 2 }))).toBe(2);
    expect(refCap(model("x", { maxRefs: 16 }))).toBe(4);
  });

  it("refSlots counts pending reads as taken, flags images over the cap, and offers an NFT only when the cap is above 0", () => {
    expect(refSlots(4, 1, 2)).toEqual({ room: 1, over: 0, nft: true });
    expect(refSlots(4, 3, 2)).toEqual({ room: 0, over: 0, nft: true });
    expect(refSlots(2, 3, 0)).toEqual({ room: 0, over: 1, nft: true });
    expect(refSlots(0, 0, 0)).toEqual({ room: 0, over: 0, nft: false });
    expect(refSlots(1, 0, 0).nft).toBe(true);
  });
});
