import { describe, it, expect } from "vitest";
import { aspectOf, gridFor } from "@/lib/og-grid";

/**
 * Kev, 2026-09-05: portrait renders sit side by side, square/landscape ones
 * tile 2×2. Cells must exactly cover the canvas — a gap or an overlap is a
 * visibly broken card on someone's timeline.
 */
const W = 1200, H = 534;
const area = (cells: { w: number; h: number }[]) => cells.reduce((a, c) => a + c.w * c.h, 0);

describe("aspectOf", () => {
  it("parses w:h and treats unknown as square", () => {
    expect(aspectOf("3:4")).toBeCloseTo(0.75);
    expect(aspectOf("16:9")).toBeCloseTo(1.777, 2);
    expect(aspectOf("1:1")).toBe(1);
    expect(aspectOf(null)).toBe(1);
    expect(aspectOf("Any")).toBe(1);
  });
});

describe("gridFor", () => {
  it("portrait: four tall cells in ONE row", () => {
    const cells = gridFor(4, aspectOf("3:4"), W, H);
    expect(cells).toHaveLength(4);
    expect(cells.every((c) => c.h === H && c.y === 0)).toBe(true);
    expect(cells.map((c) => c.x)).toEqual([0, 300, 600, 900]);
  });

  it("square: 2×2", () => {
    const cells = gridFor(4, aspectOf("1:1"), W, H);
    expect(cells.map((c) => [c.x, c.y])).toEqual([[0, 0], [600, 0], [0, 267], [600, 267]]);
    expect(area(cells)).toBeCloseTo(W * H);
  });

  it("landscape: 2×2 as well; three images span the bottom", () => {
    const four = gridFor(4, aspectOf("16:9"), W, H);
    expect(four).toHaveLength(4);
    const three = gridFor(3, aspectOf("16:9"), W, H);
    expect(three[2]).toEqual({ x: 0, y: H / 2, w: W, h: H / 2 });
    expect(area(three)).toBeCloseTo(W * H);
  });

  it("two landscape images split left/right; one fills; none is empty", () => {
    expect(gridFor(2, 1, W, H).map((c) => c.x)).toEqual([0, 600]);
    expect(gridFor(1, 1.5, W, H)).toEqual([{ x: 0, y: 0, w: W, h: H }]);
    expect(gridFor(0, 1, W, H)).toEqual([]);
  });

  it("every layout covers the canvas exactly", () => {
    for (const n of [1, 2, 3, 4]) for (const a of [0.75, 1, 1.78]) {
      expect(area(gridFor(n, a, W, H))).toBeCloseTo(W * H);
    }
  });
});
