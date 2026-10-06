import { describe, expect, it, vi } from "vitest";
import { generateImageWithPollinations } from "@/backend/services/pollinations-image-generation";

/*
 * The module under test lives in backend/services/, but vitest only collects
 * lib/ ** /__tests__ — so the test lives here rather than next to its subject.
 * Widening the include pattern to reach backend/ would sweep in every file
 * under it, including ones that talk to paid providers; the naming rules alone
 * are not worth betting the billing on. The import path is explicit, so the
 * coupling is visible.
 *
 * What this pins is the two things measured against the live free provider on
 * 2026-08-12, both of which were user-visible and neither of which any type
 * would have caught:
 *
 *   - a 429 read as a permanent failure, so a burst showed "generation failed"
 *   - "4K" asking for 1024px, which the provider caps to the same 686x858 it
 *     returns for 768px, at roughly twice the wait
 */

type FetchArgs = { url: string };

function mockFetch(response: Response): FetchArgs {
  const seen: FetchArgs = { url: "" };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    seen.url = String(input);
    return response;
  });
  return seen;
}

/** Bytes as a plain ArrayBuffer — Response's BodyInit does not take a Node Buffer. */
function bodyOf(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** A 24-byte PNG header carrying real dimensions — enough for readImageDimensions. */
function pngOf(width: number, height: number): ArrayBuffer {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return bodyOf(b);
}

/** A minimal JPEG carrying an SOF0 frame header, so the format differs from PNG. */
function jpegOf(width: number, height: number): ArrayBuffer {
  const b = Buffer.alloc(32);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0); // SOI, SOF0, length, precision
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  b.set([0xff, 0xd9], 21); // EOI
  return bodyOf(b);
}

function imageResponse(width = 686, height = 858): Response {
  return new Response(pngOf(width, height), { status: 200 });
}

function errorResponse(status: number, statusText: string): Response {
  return new Response(null, { status, statusText });
}

function dimensionsOf(url: string): { width: number; height: number } {
  const params = new URL(url).searchParams;
  return {
    width: Number(params.get("width")),
    height: Number(params.get("height")),
  };
}

describe("free provider: failure classification", () => {
  it("treats a rate limit as retryable, because it is", async () => {
    mockFetch(errorResponse(429, "Too Many Requests"));

    const result = await generateImageWithPollinations("a teapot", "1:1", "2K", "flux");

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    vi.unstubAllGlobals();
  });

  it("says the generator is busy rather than quoting a status code at the user", async () => {
    mockFetch(errorResponse(429, "Too Many Requests"));

    const result = await generateImageWithPollinations("a teapot", "1:1", "2K", "flux");

    // The route forwards this string straight to the buyer, so it has to read
    // as a temporary condition and must not carry the raw protocol detail.
    expect(result.error).toMatch(/busy/i);
    expect(result.error).not.toMatch(/429/);
    vi.unstubAllGlobals();
  });

  it("keeps server errors retryable", async () => {
    mockFetch(errorResponse(503, "Service Unavailable"));

    const result = await generateImageWithPollinations("a teapot", "1:1", "2K", "flux");

    expect(result.retryable).toBe(true);
    vi.unstubAllGlobals();
  });

  it("does not retry a request the provider rejected on its merits", async () => {
    // A 400 means the request itself is wrong; sending it again produces the
    // same 400 and burns the user's wait twice.
    mockFetch(errorResponse(400, "Bad Request"));

    const result = await generateImageWithPollinations("a teapot", "1:1", "2K", "flux");

    expect(result.retryable).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("free provider: requested size", () => {
  // Every ratio the adapter offers. The first attempt at this capped one SIDE
  // at 768 and was checked only against 1:1, which passed while 4:5 was still
  // 25% over the budget, 16:9 was 78% over and 2.39:1 was 139% over. A test
  // that walks a single ratio cannot see that, so this one walks them all.
  const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "4:5", "2:3", "2.39:1", "1:2.39"];
  const MAX_PIXELS = 589_824;

  it("never asks for more pixels than the provider will render, at any ratio", async () => {
    const overshooting: string[] = [];

    for (const resolution of ["1K", "2K", "4K"]) {
      for (const ratio of RATIOS) {
        const seen = mockFetch(imageResponse());
        await generateImageWithPollinations("a teapot", ratio, resolution, "flux");
        const { width, height } = dimensionsOf(seen.url);
        vi.unstubAllGlobals();

        // Rounding to whole pixels after the sqrt rescale can land a hair over
        // the budget; a couple of hundred pixels is not over-asking.
        if (width * height > MAX_PIXELS + 1000) {
          overshooting.push(`${resolution} ${ratio} -> ${width}x${height} (${width * height}px)`);
        }
      }
    }

    expect(overshooting).toEqual([]);
  });

  it("asks for the same size at 4K as at 2K, since the provider returns the same image", async () => {
    const at2K = mockFetch(imageResponse());
    await generateImageWithPollinations("a teapot", "4:5", "2K", "flux");
    const twoK = dimensionsOf(at2K.url);
    vi.unstubAllGlobals();

    const at4K = mockFetch(imageResponse());
    await generateImageWithPollinations("a teapot", "4:5", "4K", "flux");
    const fourK = dimensionsOf(at4K.url);
    vi.unstubAllGlobals();

    expect(fourK).toEqual(twoK);
  });

  it("still lets 1K ask for less", async () => {
    // The cap must not flatten every choice into one — 1K is a real, cheaper
    // request and stays distinct.
    const at1K = mockFetch(imageResponse());
    await generateImageWithPollinations("a teapot", "4:5", "1K", "flux");
    const oneK = dimensionsOf(at1K.url);
    vi.unstubAllGlobals();

    const at2K = mockFetch(imageResponse());
    await generateImageWithPollinations("a teapot", "4:5", "2K", "flux");
    const twoK = dimensionsOf(at2K.url);
    vi.unstubAllGlobals();

    expect(oneK.width).toBeLessThan(twoK.width);
  });

  it("lets 4K outgrow 2K again once the provider budget is raised", async () => {
    /* The ladder is deliberately kept intact in the adapter and bounded only
       by the pixel budget, so that raising POLLINATIONS_MAX_PIXELS makes the
       user's choice mean something again. Pollinations set that ceiling per
       worker (589,824 observed, 810,000 in their code, 1,048,576 in their
       provisioning script), so it genuinely does move.

       Without this test, collapsing the ladder back into a fixed one-side cap
       passes everything else — the budget clamps both arms to the same size
       today, and the regression would only surface on the day someone raises
       the ceiling and nothing gets bigger. */
    vi.stubEnv("POLLINATIONS_MAX_PIXELS", "8000000");
    vi.resetModules();
    const generous = await import("@/backend/services/pollinations-image-generation");

    const at2K = mockFetch(imageResponse());
    await generous.generateImageWithPollinations("a teapot", "4:5", "2K", "flux");
    const twoK = dimensionsOf(at2K.url);
    vi.unstubAllGlobals();

    const at4K = mockFetch(imageResponse());
    await generous.generateImageWithPollinations("a teapot", "4:5", "4K", "flux");
    const fourK = dimensionsOf(at4K.url);
    vi.unstubAllGlobals();

    vi.unstubAllEnvs();
    vi.resetModules();

    expect(fourK.width).toBeGreaterThan(twoK.width);
    expect(fourK.width * fourK.height).toBeGreaterThan(twoK.width * twoK.height);
  });

  it("keeps the aspect ratio the user chose", async () => {
    const seen = mockFetch(imageResponse());
    await generateImageWithPollinations("a teapot", "16:9", "2K", "flux");
    const { width, height } = dimensionsOf(seen.url);
    vi.unstubAllGlobals();

    expect(width).toBeGreaterThan(height);
    expect(width / height).toBeCloseTo(16 / 9, 1);
  });
});

describe("free provider: what it reports back", () => {
  it("reports the dimensions of the image it got, not the ones it asked for", async () => {
    // The provider silently shrinks over-budget requests, so echoing the
    // request would record an image that was never produced. The type in
    // ./types.ts already specifies measured-not-requested; this adapter was
    // the one still passing the caller's "2K" label straight through.
    mockFetch(imageResponse(686, 858));

    const result = await generateImageWithPollinations("a teapot", "4:5", "4K", "flux");
    vi.unstubAllGlobals();

    expect(result.metadata?.resolution).toBe("686x858");
    expect(result.metadata?.resolution).not.toBe("4K");
  });

  it("keeps what it asked for alongside, so the two can be compared", async () => {
    const seen = mockFetch(imageResponse(686, 858));
    await generateImageWithPollinations("a teapot", "4:5", "4K", "flux");
    const asked = dimensionsOf(seen.url);
    vi.unstubAllGlobals();

    mockFetch(imageResponse(686, 858));
    const result = await generateImageWithPollinations("a teapot", "4:5", "4K", "flux");
    vi.unstubAllGlobals();

    expect(result.metadata?.requestedSize).toBe(`${asked.width}x${asked.height}`);
  });

  it("reads the container format off the bytes instead of assuming one", async () => {
    // The provider serves JPEG, and this route's data URL is built from the
    // reported type — a hardcoded "png" would mislabel every image it returns.
    mockFetch(new Response(jpegOf(686, 858), { status: 200 }));
    const asJpeg = await generateImageWithPollinations("a teapot", "4:5", "2K", "flux");
    vi.unstubAllGlobals();

    mockFetch(imageResponse(686, 858));
    const asPng = await generateImageWithPollinations("a teapot", "4:5", "2K", "flux");
    vi.unstubAllGlobals();

    expect(asJpeg.metadata?.format).toBe("jpeg");
    expect(asPng.metadata?.format).toBe("png");
  });

  it("reports no resolution rather than a wrong one when the bytes are unreadable", async () => {
    mockFetch(new Response(bodyOf(Buffer.from([1, 2, 3])), { status: 200 }));

    const result = await generateImageWithPollinations("a teapot", "1:1", "2K", "flux");
    vi.unstubAllGlobals();

    expect(result.success).toBe(true);
    expect(result.metadata?.resolution).toBeNull();
  });
});

describe("the free adapter runs the model it is routed to", () => {
  it("sends the routed provider model, not a hardcoded one", async () => {
    const seen = mockFetch(imageResponse());
    const result = await generateImageWithPollinations("a teapot", "1:1", "2K", "turbo");
    expect(new URL(seen.url).searchParams.get("model")).toBe("turbo");
    expect(result.metadata?.model).toBe("turbo");
  });

  it("refuses to run without one", async () => {
    const seen = mockFetch(imageResponse());
    const result = await generateImageWithPollinations("a teapot", "1:1", "2K", "");
    expect(result).toMatchObject({ success: false, code: "MODEL_REQUIRED" });
    expect(seen.url).toBe("");
  });
});
