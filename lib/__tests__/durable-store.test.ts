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

import { putDurably, storeDeadline, storeGeneratedImage, INLINE_MAX_BYTES } from "@/lib/generation/derivative-store";

const BYTES = Buffer.from([137, 80, 78, 71]);
const ok = (name: string) => ({ url: `https://s.public.blob.vercel-storage.com/${name}` });

// A stray real SDK call would reach a closed port, never Vercel.
beforeEach(() => {
  put.mockReset();
  derivatives = null;
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
  vi.stubEnv("VERCEL_BLOB_API_URL", "http://127.0.0.1:9");
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("putDurably", () => {
  it("retries a failed put until it lands, overwriting its own earlier attempt", async () => {
    put.mockRejectedValueOnce(new Error("rate limited")).mockRejectedValueOnce(new Error("503")).mockImplementation(async (n) => ok(n));
    const p = putDurably("generations/a.png", BYTES, "image/png", Date.now() + 60_000);
    await vi.runAllTimersAsync();
    expect(await p).toBe(ok("generations/a.png").url);
    expect(put).toHaveBeenCalledTimes(3);
    expect(put.mock.calls[2][2]).toMatchObject({ allowOverwrite: true });
    expect(put.mock.calls[2][2].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("gives up at the deadline instead of running into the platform's kill", async () => {
    put.mockRejectedValue(new Error("down"));
    const p = putDurably("generations/b.png", BYTES, "image/png", Date.now() + 20_000);
    await vi.runAllTimersAsync();
    expect(await p).toBeNull();
    // 1 s, 2 s, 4 s, 8 s waits fit in 20 s; the fifth attempt is the last.
    expect(put).toHaveBeenCalledTimes(5);
  });

  it("hands the SDK an abort signal that fires at the deadline", async () => {
    vi.useRealTimers();
    put.mockImplementation((_n, _b, o) => new Promise((_r, reject) => o.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const started = Date.now();
    expect(await putDurably("generations/c.png", BYTES, "image/png", started + 50)).toBeNull();
    expect(put).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("without a token there is nothing to retry", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    expect(await putDurably("generations/d.png", BYTES, "image/png", Date.now() + 60_000)).toBeNull();
    expect(put).not.toHaveBeenCalled();
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
    await vi.runAllTimersAsync();
    expect((await p).imageUrl).toBe(DATA);
    expect(put.mock.calls.every(([name]) => !name.includes(".preview.") && !name.includes(".thumb."))).toBe(true);
  });

  it("bounds the renditions by the same deadline", async () => {
    derivatives = { preview: rendition, thumb: rendition, width: 1, height: 1 };
    put.mockImplementation(async (n) => ok(n));
    const stored = await storeGeneratedImage(DATA, "u1", Date.now() + 20_000);
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
    const refuse = HUMAN.search(/if \(!imageUrl\) \{[\s\S]{0,300}await releaseIfConsumed\(\);[\s\S]{0,80}return NextResponse\.json\(/);
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
