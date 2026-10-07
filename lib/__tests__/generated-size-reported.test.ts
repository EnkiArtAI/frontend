import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A route that generates an image must report the size it actually produced.
 *
 * The free worker clamps on TOTAL pixels before diffusing, so what a reader
 * asks for and what they receive routinely differ — a 2K request comes back
 * 686x858 at 4:5. For months the only place that disagreement was visible was
 * a database column nobody reads: the adapter measured the bytes, the route
 * computed the measurement for the media type, and then dropped it from the
 * response. The buyer surface therefore had nothing to show but the request.
 */

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(p, "utf8").split("\r\n").join("\n");
const FREE = read(join(ROOT, "app", "api", "generate-free", "route.ts"));
const VIEW = read(join(ROOT, "components", "PromptGeneratorView.tsx"));

/** The response literal the handler returns on success. */
function successPayload(src: string): string {
  const i = src.indexOf("return NextResponse.json({\n      imageUrl: delivered,");
  expect(i, "the success response literal moved — this test is reading the wrong block").toBeGreaterThan(-1);
  return src.slice(i, src.indexOf("});", i));
}

describe("generate-free reports the size it produced", () => {
  const payload = successPayload(FREE);

  it("returns measured width and height, not the requested tier", () => {
    expect(payload).toMatch(/width:\s*measured\?\.width/);
    expect(payload).toMatch(/height:\s*measured\?\.height/);
  });

  it("carries the request alongside it so the two can be compared", () => {
    // Without this the reader sees a number with nothing to compare it to,
    // and cannot tell a clamp from the size they chose.
    expect(payload).toMatch(/requestedResolution:/);
  });

  it("measures the buffer once rather than twice", () => {
    // Two calls on the same bytes could only ever agree with themselves.
    const calls = FREE.match(/readImageDimensions\(/g) ?? [];
    expect(calls.length, "readImageDimensions is called more than once on the same buffer").toBe(1);
  });

  it("the buyer view stores the server's measurement rather than re-deriving it", () => {
    expect(VIEW).toMatch(/setResultSize\(/);
    expect(VIEW).toMatch(/data\.width/);
    expect(VIEW).toMatch(/data\.height/);
    // and it must not fabricate a size from the picker
    expect(VIEW).not.toMatch(/setResultSize\(\s*\{\s*w:\s*resolution/);
  });
});
