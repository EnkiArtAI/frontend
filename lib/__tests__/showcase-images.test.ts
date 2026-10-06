import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * SHR-4. A prompt's showcase images are the share card's pictures, and the
 * card fetches them server side. Only URLs in our stores are kept; a data
 * URL is stored first (the editor sends one for free renders); anything
 * else a creator could type is dropped.
 */

const put = vi.fn<(name: string, buf: Buffer) => Promise<{ url: string }>>();
vi.mock("@vercel/blob", () => {
  class BlobError extends Error {}
  class BlobServiceRateLimited extends BlobError {}
  class BlobServiceNotAvailable extends BlobError {}
  class BlobUnknownError extends BlobError {}
  return { put: (...a: [string, Buffer]) => put(...a), BlobError, BlobServiceRateLimited, BlobServiceNotAvailable, BlobUnknownError };
});
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClientSafe: () => null }));

import { ownShowcaseImages } from "@/lib/generation/derivative-store";
import { BlobError } from "@vercel/blob";

const USER = "11111111-1111-4111-8111-111111111111";
const OURS = "https://abc.public.blob.vercel-storage.com/generations/u/1.png";
const BUCKET = "https://proj.supabase.co/storage/v1/object/public/generations/u/2.png";
const PNG = `data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString("base64")}`;

beforeEach(() => {
  put.mockReset();
  put.mockImplementation(async (name) => ({ url: `https://abc.public.blob.vercel-storage.com/${name}` }));
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
  vi.stubEnv("VERCEL_BLOB_API_URL", "http://127.0.0.1:9");
});

describe("a prompt's showcase images", () => {
  it("keeps what our stores already hold, without uploading it again", async () => {
    expect(await ownShowcaseImages([OURS, BUCKET], USER)).toEqual([OURS, BUCKET]);
    expect(put).not.toHaveBeenCalled();
  });

  it("stores a rendered data URL and keeps our copy", async () => {
    const [url] = (await ownShowcaseImages([PNG], USER))!;
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0][0]).toMatch(new RegExp(`^showcase/${USER}/\\d+_[a-z0-9]+\\.png$`));
    expect(url).toBe(`https://abc.public.blob.vercel-storage.com/${put.mock.calls[0][0]}`);
  });

  it("drops every address a creator could type", async () => {
    const typed = [
      "https://tracker.example/pixel.png",
      "http://169.254.169.254/latest/meta-data",
      "https://proj.supabase.co/storage/v1/object/public/avatars/x.png",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=",
      "javascript:alert(1)",
    ];
    expect(await ownShowcaseImages([...typed, OURS], USER)).toEqual([OURS]);
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps four at most", async () => {
    expect(await ownShowcaseImages([OURS, OURS, OURS, OURS, BUCKET], USER)).toHaveLength(4);
  });

  it("answers null when a render could not be stored, so nothing is saved without it", async () => {
    put.mockRejectedValue(new BlobError("store refused"));
    expect(await ownShowcaseImages([OURS, PNG], USER)).toBeNull();
  });
});

describe("the prompt save", () => {
  const SAVE = readSource(join(__dirname, "..", "..", "app", "api", "prompt", "route.ts"));

  it("stores the showcase only after the checks, refuses when it cannot, and saves our URLs", () => {
    const stored = SAVE.indexOf("const showcase = await ownShowcaseImages(uploadedPhotos, creatorId ?? ownerIds[0]);");
    expect(stored).toBeGreaterThan(SAVE.indexOf("if (!verdict.allowed)"));
    expect(stored).toBeLessThan(SAVE.indexOf("const promptRow = {"));
    expect(SAVE).toMatch(/if \(!showcase\) \{\n\s+return NextResponse\.json\(\{ error: "Your showcase images could not be stored right now\. Nothing was saved\." \}, \{ status: 503 \}\);/);
    expect(SAVE).toContain("showcase_images: showcase,");
    expect(SAVE).not.toContain("showcase_images: uploadedPhotos");
  });
});
