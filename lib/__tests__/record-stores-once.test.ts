import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * ENG-07 review. The free route stores its image itself, with a deadline,
 * and hands the recorder our URL plus whatever previews it got, null when
 * they failed. The recorder stored it a second time whenever the preview was
 * null: unbounded work in after(), past the function's limit in a storage
 * outage. A caller that passes previewUrl, even null, is not stored again;
 * one that passes none (the paid route) still gets its previews made here.
 */

type Row = Record<string, unknown>;
let inserts: { table: string; row: Row }[];

function chain(table: string) {
  const q: Record<string, unknown> = {
    insert: (row: Row) => { inserts.push({ table, row }); return q; },
    single: async () => ({ data: { id: `${table}-1` }, error: null }),
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
  };
  for (const m of ["select", "eq", "in", "is", "order", "limit", "maybeSingle"]) q[m] = () => q;
  return q;
}
const fake = { from: chain };

const store = vi.fn(async (url: string) => ({ imageUrl: url, previewUrl: `${url}.preview.webp`, thumbnailUrl: `${url}.thumb.webp` }));
vi.mock("@/lib/crypto", () => ({ encryptString: () => ({ encrypted: "ct", iv: "iv", authTag: "tag", kid: "k1" }) }));
vi.mock("@/lib/generation/derivative-store", () => ({ storeGeneratedImage: (url: string) => store(url) }));

import { recordGeneration } from "@/lib/generation/record";

const OURS = "https://abc.public.blob.vercel-storage.com/generations/u1/1.png";
const record = (extra: Row) =>
  recordGeneration(fake as never, {
    userId: "u1", promptId: "p1", finalPrompt: "a", effectivePrompt: "a", variableValues: {},
    model: { id: "m1", name: "Model" } as never, route: { provider: "p", providerModel: "pm" } as never,
    boost: false, aspectRatio: null, resolution: null, seed: null, output: null, generationMs: 1,
    imageUrl: OURS, ...extra,
  } as never);
const imageRow = () => inserts.find((i) => i.table === "generated_images")?.row;

beforeEach(() => {
  inserts = [];
  store.mockClear();
});

describe("the recorder", () => {
  it("does not store again what the caller stored, previews or not", async () => {
    await record({ previewUrl: null, thumbnailUrl: null });
    expect(store).not.toHaveBeenCalled();
    expect(imageRow()).toMatchObject({ storage_url: OURS, preview_url: null, thumbnail_url: null });
  });

  it("still makes the previews for a caller that brought none", async () => {
    await record({});
    expect(store).toHaveBeenCalledOnce();
    expect(imageRow()).toMatchObject({ storage_url: OURS, preview_url: `${OURS}.preview.webp` });
  });
});
