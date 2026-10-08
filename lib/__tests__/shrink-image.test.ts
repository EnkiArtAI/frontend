import { describe, it, expect, vi, afterEach } from "vitest";
import { fitWithin, shrinkImage, fitUpload } from "@/lib/shrink-image";
import { REQUEST_MAX_BYTES } from "@/lib/request-size";
import { readReference } from "@/hooks/useReferenceReads";

/**
 * Images are made smaller in the browser before they travel (Kev,
 * 2026-10-08): Vercel turns away a body over 4.5 MB, and base64 adds a
 * third. The browser's decoder and canvas are faked: what they are asked to
 * draw and encode is the behaviour under test.
 */

afterEach(() => vi.unstubAllGlobals());

type Canvas = {
  width: number;
  height: number;
  asked: [string, number][];
  ctx: { imageSmoothingQuality: string; drawImage: ReturnType<typeof vi.fn> };
};

/**
 * A browser that decodes any image to `size`, encodes WebP as `webpAs`
 * (Safari answers image/png), sees every alpha byte as `alpha`, and makes
 * each encoded file `bytes(canvas, quality)` long.
 */
function fakeBrowser({
  size = [4000, 3000],
  webpAs = "image/webp",
  alpha = 255,
  decodes = true,
  bytes = () => 100,
}: { size?: [number, number]; webpAs?: string; alpha?: number; decodes?: boolean; bytes?: (c: Canvas, q: number) => number } = {}) {
  const canvases: Canvas[] = [];
  const bitmap = { width: size[0], height: size[1], close: vi.fn() };
  const decode = vi.fn(async () => {
    if (!decodes) throw new DOMException("The source image could not be decoded.", "InvalidStateError");
    return bitmap;
  });
  vi.stubGlobal("createImageBitmap", decode);
  vi.stubGlobal("document", {
    createElement: () => {
      const ctx = { imageSmoothingQuality: "low", drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, alpha]) }) };
      const c = {
        width: 0, height: 0, asked: [] as [string, number][], ctx,
        getContext: () => ctx,
        toBlob(done: (b: Blob | null) => void, type: string, q: number) {
          c.asked.push([type, q]);
          done(new Blob([new Uint8Array(bytes(c, q))], { type: type === "image/webp" ? webpAs : type }));
        },
      };
      canvases.push(c);
      return c;
    },
  });
  return { canvases, bitmap, decode };
}

describe("fitWithin", () => {
  it("brings the long edge down to the limit and keeps the shape", () => {
    expect(fitWithin(4000, 3000, 1024)).toEqual({ width: 1024, height: 768 });
    expect(fitWithin(3000, 4000, 1024)).toEqual({ width: 768, height: 1024 });
  });

  it("never enlarges a smaller image", () => {
    expect(fitWithin(800, 600, 1024)).toEqual({ width: 800, height: 600 });
  });

  it("keeps a sliver at least one pixel high", () => {
    expect(fitWithin(10_000, 2, 1024)).toEqual({ width: 1024, height: 1 });
  });
});

describe("a reference", () => {
  it("is drawn upright, smoothly, at most 1024 px, and sent as WebP at 0.85", async () => {
    const { canvases, bitmap, decode } = fakeBrowser();
    const src = new Blob(["x"], { type: "image/png" });
    const out = await shrinkImage(src);
    expect(out.type).toBe("image/webp");
    expect(decode).toHaveBeenCalledWith(src, { imageOrientation: "from-image" });
    expect(canvases[0]).toMatchObject({ width: 1024, height: 768, asked: [["image/webp", 0.85]] });
    expect(canvases[0].ctx.imageSmoothingQuality).toBe("high");
    expect(canvases[0].ctx.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1024, 768);
  });

  it("the browser cannot decode goes as it came, for the server to judge", async () => {
    fakeBrowser({ decodes: false });
    const src = new Blob(["x"], { type: "image/heic" });
    await expect(shrinkImage(src)).resolves.toBe(src);
  });

  it("goes as a JPEG of the same quality where WebP cannot be encoded (Safari), when opaque", async () => {
    const { canvases } = fakeBrowser({ webpAs: "image/png" });
    expect((await shrinkImage(new Blob(["x"]))).type).toBe("image/jpeg");
    expect(canvases[0].asked).toEqual([["image/webp", 0.85], ["image/jpeg", 0.85]]);
  });

  it("stays a PNG there when anything shows through it, so its transparency is kept", async () => {
    const { canvases } = fakeBrowser({ webpAs: "image/png", alpha: 254 });
    expect((await shrinkImage(new Blob(["x"]))).type).toBe("image/png");
    expect(canvases[0].asked).toEqual([["image/webp", 0.85]]);
  });

  it("is read shrunk on every path, a picked file and a fetched link alike", async () => {
    fakeBrowser();
    // The reader is handed what travels.
    vi.stubGlobal("FileReader", class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(b: Blob) { queueMicrotask(() => { this.result = `data:${b.type};base64,AA==`; this.onload?.(); }); }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["x"], { type: "image/gif" }))));
    await expect(readReference(new Blob(["x"], { type: "image/png" }))).resolves.toBe("data:image/webp;base64,AA==");
    await expect(readReference("https://arweave.net/a.gif")).resolves.toBe("data:image/webp;base64,AA==");
  });
});

describe("a gallery or message image", () => {
  const file = (size: number, name = "a.png") => new File([new Uint8Array(size)], name, { type: "image/png" });

  it("is drawn anew even when it fits, so nothing the camera wrote (where it was taken) goes along", async () => {
    const { canvases } = fakeBrowser({ size: [1200, 900] });
    const f = file(1000, "photo.png");
    const out = await fitUpload(f);
    expect(out).not.toBe(f);
    expect([out?.name, out?.type]).toEqual(["photo.webp", "image/webp"]);
    expect(canvases.map((c) => [c.width, ...c.asked[0]])).toEqual([[1200, "image/webp", 0.9]]);
  });

  it("too large is stepped down at 2560 px, quality first, until it fits", async () => {
    const { canvases } = fakeBrowser({ bytes: (_c, q) => (q > 0.7 ? REQUEST_MAX_BYTES + 1 : REQUEST_MAX_BYTES) });
    const out = await fitUpload(file(REQUEST_MAX_BYTES + 1, "render.png"));
    expect(canvases.map((c) => [c.width, ...c.asked[0]])).toEqual([[2560, "image/webp", 0.9], [2560, "image/webp", 0.8], [2560, "image/webp", 0.7]]);
    expect([out?.name, out?.type, out?.size]).toEqual(["render.webp", "image/webp", REQUEST_MAX_BYTES]);
  });

  it("with no quality to give (Safari's transparent PNG) is made smaller instead", async () => {
    const { canvases } = fakeBrowser({ webpAs: "image/png", alpha: 0, bytes: (c) => (c.width > 2048 ? REQUEST_MAX_BYTES + 1 : REQUEST_MAX_BYTES) });
    const out = await fitUpload(file(REQUEST_MAX_BYTES + 1));
    expect(canvases.map((c) => c.width)).toEqual([2560, 2560, 2560, 2048]);
    expect([out?.name, out?.type]).toEqual(["a.png", "image/png"]);
  });

  it("is refused (null) when no step fits", async () => {
    const { canvases } = fakeBrowser({ bytes: () => REQUEST_MAX_BYTES + 1 });
    await expect(fitUpload(file(REQUEST_MAX_BYTES + 1))).resolves.toBeNull();
    expect(canvases.map((c) => c.width)).toEqual([2560, 2560, 2560, 2048, 1600]);
  });

  it("is refused at once, small or large, when the browser cannot read it: no step would", async () => {
    for (const size of [100, REQUEST_MAX_BYTES + 1]) {
      const { decode } = fakeBrowser({ decodes: false });
      await expect(fitUpload(file(size))).resolves.toBeNull();
      expect(decode).toHaveBeenCalledTimes(1);
    }
  });
});
