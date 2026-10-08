import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * REC-2. Kev, 2026-10-06: "bild upload darf nicht failen. ist ein bild
 * erstellt worden, so muss das geliefert werden und die zahlung an uns
 * weitergegeben werden." A failed upload used to fall back to an inline data
 * URL of any size, which was captured and then refused by the platform's
 * 4.5 MB response cap: the buyer paid and got HTTP 413.
 */

type PutOpts = { allowOverwrite?: boolean; abortSignal?: AbortSignal };
const put = vi.fn<(name: string, buf: Buffer, opts: PutOpts) => Promise<{ url: string }>>();
vi.mock("@vercel/blob", () => {
  class BlobError extends Error {}
  class BlobServiceRateLimited extends BlobError {}
  class BlobServiceNotAvailable extends BlobError {}
  class BlobUnknownError extends BlobError {}
  return { put: (...a: [string, Buffer, PutOpts]) => put(...a), BlobError, BlobServiceRateLimited, BlobServiceNotAvailable, BlobUnknownError };
});
let derivatives: unknown = null;
vi.mock("@/lib/imageDerivatives", () => ({ tryMakeDerivatives: async () => derivatives }));

// The fallback bucket: off unless a test turns it on.
const upload = vi.fn<(name: string, buf: Buffer, opts: { contentType: string; upsert: boolean }) => Promise<{ error: unknown }>>();
const SUPA = "https://proj.supabase.co/storage/v1/object/public/generations/";
let fallbackOn = false;
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClientSafe: () =>
    fallbackOn
      ? { storage: { from: () => ({ upload: (...a: Parameters<typeof upload>) => upload(...a), getPublicUrl: (n: string) => ({ data: { publicUrl: SUPA + n } }) }) } }
      : null,
}));

/** Runs fake time forward until the promise settles; the store lookup is async before any timer exists. */
async function settle<T>(p: Promise<T>, stepMs = 1_000, steps = 400): Promise<T> {
  let done = false;
  void p.finally(() => { done = true; });
  for (let i = 0; i < steps && !done; i++) await vi.advanceTimersByTimeAsync(stepMs);
  return p;
}

import { putDurably, storeDeadline, storeGeneratedImage, INLINE_MAX_BYTES } from "@/lib/generation/derivative-store";

const BYTES = Buffer.from([137, 80, 78, 71]);
const ok = (name: string) => ({ url: `https://s.public.blob.vercel-storage.com/${name}` });

// A stray real SDK call would reach a closed port, never Vercel.
beforeEach(() => {
  put.mockReset();
  upload.mockReset();
  fallbackOn = false;
  derivatives = null;
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
  vi.stubEnv("VERCEL_BLOB_API_URL", "http://127.0.0.1:9");
  vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co"); // the project SUPA's bucket belongs to
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("putDurably", () => {
  it("retries a failed put until it lands, overwriting its own earlier attempt", async () => {
    put.mockRejectedValueOnce(new Error("rate limited")).mockRejectedValueOnce(new Error("503")).mockImplementation(async (n) => ok(n));
    const p = putDurably("generations/a.png", BYTES, "image/png", Date.now() + 60_000);
    expect(await settle(p)).toBe(ok("generations/a.png").url);
    expect(put).toHaveBeenCalledTimes(3);
    expect(put.mock.calls[2][2]).toMatchObject({ allowOverwrite: true });
    expect(put.mock.calls[2][2].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("gives up at the deadline instead of running into the platform's kill", async () => {
    put.mockRejectedValue(new Error("down"));
    const p = putDurably("generations/b.png", BYTES, "image/png", Date.now() + 20_000);
    expect(await settle(p)).toBeNull();
    // 1 s, 2 s, 4 s, 8 s waits fit in 20 s; the fifth attempt is the last.
    expect(put).toHaveBeenCalledTimes(5);
  });

  it("hands the SDK an abort signal that fires at the deadline as an AbortError, the one it stops on", async () => {
    vi.useRealTimers();
    let signal: AbortSignal | undefined;
    put.mockImplementation((_n, _b, o) => { signal = o.abortSignal; return new Promise(() => {}); });
    const started = Date.now();
    expect(await putDurably("generations/c.png", BYTES, "image/png", started + 50)).toBeNull();
    expect(put).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as DOMException).name).toBe("AbortError");
  });

  it("without a token there is nothing to retry", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    expect(await putDurably("generations/d.png", BYTES, "image/png", Date.now() + 60_000)).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });
});

describe("the fallback bucket", () => {
  it("takes the image in the same round when Blob fails, so an outage costs no wait", async () => {
    fallbackOn = true;
    put.mockRejectedValue(new Error("503"));
    upload.mockResolvedValue({ error: null });
    expect(await settle(putDurably("generations/f.png", BYTES, "image/png", Date.now() + 60_000))).toBe(SUPA + "generations/f.png");
    expect(put).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][2]).toMatchObject({ contentType: "image/png", upsert: true });
  });

  it("gets its turn when Blob hangs inside its own retries", async () => {
    fallbackOn = true;
    put.mockImplementation(() => new Promise(() => {}));
    upload.mockResolvedValue({ error: null });
    const p = putDurably("generations/h.png", BYTES, "image/png", Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(upload).not.toHaveBeenCalled();
    expect(await settle(p)).toBe(SUPA + "generations/h.png");
  });

  it("is used alone where no Blob token is configured", async () => {
    fallbackOn = true;
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    upload.mockResolvedValue({ error: null });
    expect(await settle(putDurably("generations/n.png", BYTES, "image/png", Date.now() + 60_000))).toBe(SUPA + "generations/n.png");
    expect(put).not.toHaveBeenCalled();
  });

  it("drops out of the put when it refuses for good (a missing bucket), and Blob keeps its turns", async () => {
    fallbackOn = true;
    put.mockRejectedValueOnce(new Error("503")).mockRejectedValueOnce(new Error("503")).mockImplementation(async (n) => ok(n));
    upload.mockResolvedValue({ error: Object.assign(new Error("Bucket not found"), { status: 404 }) });
    expect(await settle(putDurably("generations/m.png", BYTES, "image/png", Date.now() + 60_000))).toBe(ok("generations/m.png").url);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("keeps an image already in the bucket where it is", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(BYTES), { headers: { "content-type": "image/png" } }));
    put.mockImplementation(async (n) => ok(n));
    const url = SUPA + "generations/u1/x.png";
    const stored = await storeGeneratedImage(url, "u1");
    vi.unstubAllGlobals();
    expect(stored.imageUrl).toBe(url);
    expect(put).not.toHaveBeenCalled();
  });

  it("takes a paid image without a Blob token at all, through storeGeneratedImage too", async () => {
    fallbackOn = true;
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    upload.mockResolvedValue({ error: null });
    const stored = await settle(storeGeneratedImage(`data:image/png;base64,${BYTES.toString("base64")}`, "u1", Date.now() + 60_000));
    expect(stored.imageUrl.startsWith(SUPA)).toBe(true);
  });
});

describe("the deadline and the inline cap", () => {
  it("stores by 285 s into the request and never later, so capture and answer keep 15 s", () => {
    const now = Date.now();
    expect(storeDeadline(now)).toBe(now + 285_000);
    expect(storeDeadline(now - 289_000)).toBe(now - 4_000);
  });

  it("keeps an inline image under the 4.5 MB response cap after base64", () => {
    expect(Math.ceil(INLINE_MAX_BYTES / 3) * 4).toBeLessThan(4_500_000 - 10_000);
  });
});

describe("storeGeneratedImage with a deadline", () => {
  const DATA = `data:image/png;base64,${BYTES.toString("base64")}`;
  const rendition = { buffer: BYTES, bytes: 4 };

  it("cuts no renditions when the original did not land", async () => {
    derivatives = { preview: rendition, thumb: rendition, width: 1, height: 1 };
    put.mockRejectedValue(new Error("down"));
    const p = storeGeneratedImage(DATA, "u1", Date.now() + 20_000);
    expect((await settle(p)).imageUrl).toBe(DATA);
    expect(put.mock.calls.every(([name]) => !name.includes(".preview.") && !name.includes(".thumb."))).toBe(true);
  });

  it("gives the optional renditions 10 s at most, not the paid deadline", async () => {
    derivatives = { preview: rendition, thumb: rendition, width: 1, height: 1 };
    put.mockImplementation(async (n) => { if (n.includes(".png")) return ok(n); throw new Error("rate limited"); });
    let done = false;
    const p = storeGeneratedImage(DATA, "u1", Date.now() + 200_000).then((r) => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(done).toBe(false); // still retrying the renditions
    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).toBe(true); // within 10 s, far short of the 200 s deadline
    const stored = await p;
    expect(stored.imageUrl).toMatch(/\.png$/);
    expect(stored.previewUrl).toBeNull();
  });

  it("names every copy it may have made, returned or not, so a refusal takes them all down", async () => {
    derivatives = { preview: rendition, thumb: rendition, width: 1, height: 1 };
    // The original's upload is cut, yet may land; the renditions never start.
    put.mockRejectedValue(new Error("cut"));
    const stored = await settle(storeGeneratedImage(DATA, "u1", Date.now() + 20_000));
    expect(stored.imageUrl).toBe(DATA);
    expect(stored.names).toEqual([expect.stringMatching(/^generations\/u1\/\d+_[a-z0-9]+\.png$/), expect.any(String), expect.any(String)]);
    const base = stored.names[0].replace(/\.png$/, "");
    expect(stored.names.slice(1)).toEqual([`${base}.preview.webp`, `${base}.thumb.webp`]);
    expect(put.mock.calls.map(([name]) => name)).toContain(stored.names[0]);
  });

  it("bounds the renditions by the same deadline", async () => {
    derivatives = { preview: rendition, thumb: rendition, width: 1, height: 1 };
    put.mockImplementation(async (n) => ok(n));
    const stored = await settle(storeGeneratedImage(DATA, "u1", Date.now() + 20_000));
    expect(stored.previewUrl).toMatch(/\.preview\.webp$/);
    expect(put.mock.calls).toHaveLength(3);
    expect(put.mock.calls.every(([, , o]) => o.abortSignal instanceof AbortSignal)).toBe(true);
  });
});

describe("the paid routes", () => {
  const ROOT = join(__dirname, "..", "..");
  const HUMAN = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
  const AGENT = readSource(join(ROOT, "app", "api", "x402", "generate", "route.ts"));

  it("the human route stores durably, inlines only what fits, and charges only after", () => {
    const store = HUMAN.search(/await putDurably\(/);
    const fits = HUMAN.search(/generatedImageBuffer\.length <= INLINE_MAX_BYTES/);
    const refuse = HUMAN.search(/if \(!imageUrl \|\| Date\.now\(\) > storeDeadline\(startedAt\)\) \{[\s\S]{0,300}await releaseIfConsumed\(\);[\s\S]{0,80}return NextResponse\.json\(/);
    const capture = HUMAN.search(/await captureAndBroadcast\(/);
    expect(store).toBeGreaterThan(-1);
    expect(fits).toBeGreaterThan(store);
    expect(refuse).toBeGreaterThan(fits);
    expect(capture).toBeGreaterThan(refuse);
    expect(HUMAN).not.toMatch(/uploadError/);
  });

  it("the human route uploads references after the answer, not before it", () => {
    expect(HUMAN).toMatch(/after\(async \(\) =>\s+recordGeneration\(recSupabase, \{[\s\S]{0,2500}references: await storeReferenceImages\(/);
  });

  it("the agent route stores durably and never answers with an inline image too big to arrive", () => {
    expect(AGENT).toMatch(/await storeGeneratedImage\(dataUrl, "x402-agent", storeDeadline\(startedAt\)\)/);
    const guard = AGENT.search(/if \(stored\.imageUrl === dataUrl && buffer\.length > INLINE_MAX_BYTES\) \{/);
    const answer = AGENT.search(/imageUrl: stored\.imageUrl,/);
    expect(guard).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(guard);
  });
});
