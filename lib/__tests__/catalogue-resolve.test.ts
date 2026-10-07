import { describe, it, expect } from "vitest";
import { resolveCatalogueEntry, type CatalogueEntry } from "@/hooks/useModelLimits";

/**
 * Drafts store the model as a SLUG ("nano-banana-pro"); the live models table
 * keys rows by UUID. An exact-id find missed for every draft that never
 * re-picked its model: the doc select rendered the raw slug, the gpt lever
 * never appeared, and the cost line showed $0.00 for the default model.
 */
const CAT: CatalogueEntry[] = [
  { id: "db00c518-ee31-4d12-b40a-f8130f8e605b", name: "Nano Banana Pro", price: 0.14, mediaType: "image" as const, supportsQuality: false, maxResolution: "4K", ratios: ["1:1"], free: false },
  { id: "14b3db65-08e3-49a5-b8bb-57f6d5821099", name: "GPT-Image-2", price: 0.17, mediaType: "image" as const, supportsQuality: true, maxResolution: "4K", ratios: ["1:1"], free: false },
  { id: "fee61592-88fc-4235-b060-2fc76b49bf89", name: "Flux (free)", price: 0, mediaType: "image" as const, supportsQuality: false, maxResolution: "2K", ratios: ["1:1"], free: true },
];

describe("resolveCatalogueEntry", () => {
  it("matches a real UUID id directly", () => {
    expect(resolveCatalogueEntry(CAT, "14b3db65-08e3-49a5-b8bb-57f6d5821099")?.name).toBe("GPT-Image-2");
  });

  it("matches a draft's slug against the name's family — the live-bug case", () => {
    // st.models starts as ["nano-banana-pro"]; the DB row is a UUID. This is
    // the lookup that returned undefined and zeroed the cost line.
    expect(resolveCatalogueEntry(CAT, "nano-banana-pro")?.price).toBe(0.14);
    expect(resolveCatalogueEntry(CAT, "gpt-image-2")?.supportsQuality).toBe(true);
    expect(resolveCatalogueEntry(CAT, "flux-free")?.maxResolution).toBe("2K");
  });

  it("prefers an exact id over a slug collision", () => {
    // If a row's UUID ever equalled another row's slug, identity must win.
    const cat = [...CAT, { id: "nano-banana-pro", name: "Impostor", price: 9, mediaType: "image" as const, supportsQuality: false, maxResolution: "1K" as const, ratios: ["1:1"], free: false }];
    expect(resolveCatalogueEntry(cat, "nano-banana-pro")?.name).toBe("Impostor");
  });

  it("returns undefined for nothing and for strangers — never a guess", () => {
    expect(resolveCatalogueEntry(CAT, undefined)).toBeUndefined();
    expect(resolveCatalogueEntry(CAT, "midjourney")).toBeUndefined();
    expect(resolveCatalogueEntry(CAT, "")).toBeUndefined();
  });
});
