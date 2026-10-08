import { describe, it, expect, beforeEach, vi } from "vitest";
import { crc32 } from "node:zlib";
import sharp from "sharp";

/**
 * The judges see what the calibration of 2026-10-08 measured: a JPEG of at
 * most 1024 px made from the bytes in hand, never a 4K original. They see one
 * frame, so an animation is refused, and a transparent image is seen on black
 * and on white.
 */

const seen = vi.hoisted(() => ({ urls: [] as string[], answers: [] as Record<string, unknown>[] }));
vi.mock("@/lib/moderation/image-check", () => ({
  checkImage: async (url: string) => { seen.urls.push(url); return seen.answers.shift() ?? { verdict: "clear" }; },
}));

import { checkImageBytes, dataUrlBytes } from "@/lib/moderation/image-check-bytes";

beforeEach(() => { seen.urls = []; seen.answers = []; });

const image = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
const rgba = (alpha: number) =>
  sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 128, g: 128, b: 128, alpha } } }).png().toBuffer();
const pixel = async (url: string) => [...(await sharp(dataUrlBytes(url)!).raw().toBuffer()).subarray(0, 3)];

/** A PNG with one more chunk right after its header. */
const withChunk = (png: Buffer, type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  const end = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, end), len, body, crc, png.subarray(end)]);
};

describe("checkImageBytes", () => {
  it("shows the judges a JPEG of at most 1024 px on the long edge", async () => {
    expect(await checkImageBytes(await image(3840, 2160))).toEqual({ verdict: "clear" });
    expect(seen.urls).toHaveLength(1);
    const bytes = dataUrlBytes(seen.urls[0])!;
    expect(seen.urls[0].startsWith("data:image/jpeg;base64,")).toBe(true);
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([1024, 576]);
  });

  it("never enlarges a small image", async () => {
    await checkImageBytes(await image(300, 200));
    expect((await sharp(dataUrlBytes(seen.urls[0])!).metadata()).width).toBe(300);
  });

  it("answers bytes that are no image with unavailable, and asks nobody", async () => {
    expect(await checkImageBytes(Buffer.from("not an image"))).toEqual({ verdict: "unavailable", reason: "not an image" });
    expect(seen.urls).toEqual([]);
  });

  it("judges a still GIF, WebP and JPEG", async () => {
    for (const still of [await sharp(await image(8, 8)).gif().toBuffer(), await sharp(await image(8, 8)).webp().toBuffer(), await sharp(await image(8, 8)).jpeg().toBuffer()]) {
      expect(await checkImageBytes(still)).toEqual({ verdict: "clear" });
    }
    expect(seen.urls).toHaveLength(3);
  });

  it("refuses an animation, which the judges would see by its first frame only, and asks nobody", async () => {
    const frames = [await image(8, 8), await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer()];
    for (const animated of [
      await sharp(frames, { join: { animated: true } }).gif().toBuffer(),
      await sharp(frames, { join: { animated: true } }).webp().toBuffer(),
      withChunk(await image(8, 8), "acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])),
    ]) {
      expect(await checkImageBytes(animated)).toEqual({ verdict: "blocked", reason: "not a still" });
    }
    expect(seen.urls).toEqual([]);
  });

  it("reads an APNG's chunks, so a still PNG whose text says acTL is still judged", async () => {
    expect(await checkImageBytes(withChunk(await image(8, 8), "tEXt", Buffer.from("Comment\0acTL", "latin1")))).toEqual({ verdict: "clear" });
    expect(seen.urls).toHaveLength(1);
  });

  it("refuses a format a browser may play or that is no picture (SVG, TIFF), and asks nobody", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
    for (const other of [svg, await sharp(await image(8, 8)).tiff().toBuffer()]) {
      expect(await checkImageBytes(other)).toEqual({ verdict: "blocked", reason: "not a still" });
    }
    expect(seen.urls).toEqual([]);
  });

  it("judges a transparent image on black and on white", async () => {
    await checkImageBytes(await rgba(0));
    expect(seen.urls).toHaveLength(2);
    expect(await pixel(seen.urls[0])).toEqual([0, 0, 0]);
    expect((await pixel(seen.urls[1])).every((c) => c >= 250)).toBe(true);
  });

  it("judges an image with an alpha channel but no transparency once", async () => {
    await checkImageBytes(await rgba(1));
    expect(seen.urls).toHaveLength(1);
  });

  it("keeps the worse of the two views, a child-safety one above all", async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
      [{ verdict: "clear" }, { verdict: "child_safety", scores: { minor: 0.9 } }, "child_safety"],
      [{ verdict: "child_safety" }, { verdict: "blocked", reason: "explicit" }, "child_safety"],
      [{ verdict: "unavailable", reason: "x" }, { verdict: "blocked", reason: "explicit" }, "blocked"],
      [{ verdict: "adult", reason: "suggestive" }, { verdict: "unavailable", reason: "x" }, "unavailable"],
      [{ verdict: "clear" }, { verdict: "adult", reason: "graphic" }, "adult"],
    ];
    for (const [onBlack, onWhite, worst] of cases) {
      seen.answers = [onBlack, onWhite];
      expect((await checkImageBytes(await rgba(0.5))).verdict).toBe(worst);
    }
    seen.answers = [{ verdict: "clear" }, { verdict: "child_safety", scores: { minor: 0.9 } }];
    expect(await checkImageBytes(await rgba(0.5))).toEqual({ verdict: "child_safety", scores: { minor: 0.9 } });
  });
});

describe("dataUrlBytes", () => {
  it("reads a base64 data: URL and nothing else", () => {
    expect(dataUrlBytes("data:image/png;base64,aGVsbG8=")?.toString()).toBe("hello");
    expect(dataUrlBytes("https://x.test/a.png")).toBeNull();
    expect(dataUrlBytes("data:text/plain,hello")).toBeNull();
  });
});
