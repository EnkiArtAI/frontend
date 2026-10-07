import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveModel, resolveModelByFamily } from "@/lib/generation/models";
import { resolveCatalogueEntry, type CatalogueEntry } from "@/hooks/useModelLimits";

/**
 * A resolver that has to choose between rows chooses wrong as often as right,
 * and the wrong choice is a model nobody selected. Each one now answers with
 * exactly the selected row or nothing.
 */

const NANO = { id: "db00c518-ee31-4d12-b40a-f8130f8e605b", name: "Nano Banana Pro" };
const NANO_BETA = { id: "db00c518-ee31-4d12-b40a-f8130f8e6000", name: "Nano Banana Pro (beta)" };
const GPT = { id: "14b3db65-08e3-49a5-b8bb-57f6d5821099", name: "GPT-Image-2" };

/** Both resolvers' chains, awaited at the end: .in() narrows by id, .eq() answers. */
function models(rows: Array<{ id: string; name: string }>) {
  let ids: string[] | null = null;
  const chain = {
    select: () => chain,
    in: (_c: string, v: string[]) => { ids = v; return chain; },
    eq: () => Promise.resolve({ data: ids ? rows.filter((r) => ids!.includes(r.id)) : rows, error: null }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe("resolveModel", () => {
  it("resolves exactly the first id and never skips to the next one", async () => {
    const db = models([NANO, GPT]);
    expect((await resolveModel(db, [GPT.id]))?.name).toBe("GPT-Image-2");
    expect(await resolveModel(db, ["00000000-0000-4000-8000-000000000000", GPT.id])).toBeNull();
    expect(await resolveModel(db, ["nano-banana-pro", GPT.id])).toBeNull();
  });
});

describe("resolveModelByFamily", () => {
  it("refuses a family two active rows answer to", async () => {
    expect(await resolveModelByFamily(models([NANO, NANO_BETA, GPT]), "nano-banana-pro")).toBeNull();
    expect((await resolveModelByFamily(models([NANO, GPT]), "nano-banana-pro"))?.name).toBe("Nano Banana Pro");
  });
});

describe("resolveCatalogueEntry", () => {
  const entry = (m: { id: string; name: string }, price: number): CatalogueEntry => ({
    ...m, price, mediaType: "image", supportsQuality: false, maxResolution: "4K", ratios: ["1:1"], free: false,
  });

  it("resolves a slug only when exactly one row answers to it", () => {
    const cat = [entry(NANO_BETA, 0), entry(NANO, 0.14), entry(GPT, 0.1)];
    expect(resolveCatalogueEntry(cat, "nano-banana-pro")).toBeUndefined();
    expect(resolveCatalogueEntry(cat, NANO.id)?.name).toBe("Nano Banana Pro");
    expect(resolveCatalogueEntry(cat, "gpt-image-2")?.name).toBe("GPT-Image-2");
  });
});
