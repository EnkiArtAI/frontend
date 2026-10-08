import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * An image the image check refused is taken down from wherever it was
 * stored (2026-10-08): our Blob store by URL, our fallback bucket by path, a
 * bare pathname from both. Nothing of anyone else's; never a throw.
 */

const calls = vi.hoisted(() => ({ del: [] as unknown[], remove: [] as unknown[], delFails: false, removeFails: false }));
vi.mock("@vercel/blob", () => ({
  del: async (x: unknown) => { calls.del.push(x); if (calls.delFails) throw new Error("blob down"); },
}));
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClientSafe: () => ({
    storage: { from: (b: string) => ({ remove: async (paths: string[]) => { calls.remove.push([b, paths]); return { error: calls.removeFails ? { message: "bucket down" } : null }; } }) },
  }),
}));

import { removeStored } from "@/lib/generation/derivative-store";

const BLOB = "https://abcstore.public.blob.vercel-storage.com/generations/u1/1_x.png";
const BUCKET = "https://proj.supabase.co/storage/v1/object/public/generations/generations/u1/1_x.preview.webp";

beforeEach(() => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_ABCSTORE_secret");
  vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
  Object.assign(calls, { del: [], remove: [], delFails: false, removeFails: false });
});
afterEach(() => vi.unstubAllEnvs());

describe("removeStored", () => {
  it("takes our Blob copy down by URL and our bucket copy by path", async () => {
    await removeStored([BLOB, BUCKET, null, undefined]);
    expect(calls.del).toEqual([[BLOB]]);
    expect(calls.remove).toEqual([["generations", ["generations/u1/1_x.preview.webp"]]]);
  });

  it("removes a bare pathname from both stores: an aborted Blob turn may still have landed it", async () => {
    await removeStored(["generations/9_y.png"]);
    expect(calls.del).toEqual([["generations/9_y.png"]]);
    expect(calls.remove).toEqual([["generations", ["generations/9_y.png"]]]);
  });

  it("leaves data: URLs and other people's stores alone", async () => {
    await removeStored(["data:image/png;base64,AAAA", "https://other.public.blob.vercel-storage.com/a.png", "https://elsewhere.supabase.co/storage/v1/object/public/generations/a.png"]);
    expect(calls.del).toEqual([]);
    expect(calls.remove).toEqual([]);
  });

  it("logs a failed removal and never throws: the refusal still answers", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    Object.assign(calls, { delFails: true, removeFails: true });
    await expect(removeStored([BLOB, BUCKET])).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});
