import { describe, it, expect, beforeEach, vi } from "vitest";
import sharp from "sharp";

/**
 * The judges see what the calibration of 2026-10-08 measured: a JPEG of at
 * most 1024 px made from the bytes in hand, never a 4K original.
 */

const seen = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("@/lib/moderation/image-check", () => ({
  checkImage: async (url: string) => { seen.urls.push(url); return { verdict: "clear" }; },
}));

import { checkImageBytes, dataUrlBytes } from "@/lib/moderation/image-check-bytes";

beforeEach(() => { seen.urls = []; });

const image = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();

describe("checkImageBytes", () => {
  it("shows the judges a JPEG of at most 1024 px on the long edge", async () => {
    expect(await checkImageBytes(await image(3840, 2160))).toEqual({ verdict: "clear" });
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
});

describe("dataUrlBytes", () => {
  it("reads a base64 data: URL and nothing else", () => {
    expect(dataUrlBytes("data:image/png;base64,aGVsbG8=")?.toString()).toBe("hello");
    expect(dataUrlBytes("https://x.test/a.png")).toBeNull();
    expect(dataUrlBytes("data:text/plain,hello")).toBeNull();
  });
});
