import { describe, expect, it } from "vitest";
import { packMasonry, type Box } from "../masonry";

const grid = { width: 412, cols: 4, gap: 4, spanWide: false };

/** Deterministic ratios between 0.5 and 2. */
function ratios(seed: number, n: number): number[] {
  let s = seed;
  return Array.from({ length: n }, () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return 0.5 + (s / 2147483648) * 1.5;
  });
}

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;

describe("packMasonry", () => {
  it("fills the shortest column, ties to the left", () => {
    // 412 wide, 4 columns, gap 4 → columns 100 wide at x 0, 104, 208, 312.
    const { boxes } = packMasonry([1, 0.5, 1, 1, 2], grid);
    expect(boxes.slice(0, 4).map((b) => b.x)).toEqual([0, 104, 208, 312]);
    expect(boxes[0]).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(boxes[1]).toEqual({ x: 104, y: 0, w: 100, h: 200 });
    // Columns 0, 2 and 3 end at 104; the leftmost of them wins.
    expect(boxes[4]).toEqual({ x: 0, y: 104, w: 100, h: 50 });
  });

  it("is as tall as its longest column, and 0 when empty", () => {
    expect(packMasonry([1, 0.5, 1, 1, 2], grid).height).toBe(200);
    expect(packMasonry([], grid)).toEqual({ boxes: [], height: 0 });
  });

  it("never moves a placed box when more are appended", () => {
    for (const seed of [1, 7, 42, 99]) {
      const all = ratios(seed, 60);
      for (const cols of [2, 3, 4]) {
        for (const spanWide of [false, true]) {
          const full = packMasonry(all, { ...grid, cols, spanWide }).boxes;
          for (let k = 0; k <= all.length; k++) {
            expect(packMasonry(all.slice(0, k), { ...grid, cols, spanWide }).boxes).toEqual(full.slice(0, k));
          }
        }
      }
    }
  });

  it("never overlaps two boxes, and keeps every box inside the width", () => {
    for (const seed of [3, 11, 2024]) {
      for (const cols of [2, 3, 4]) {
        for (const spanWide of [false, true]) {
          const { boxes } = packMasonry(ratios(seed, 80), { ...grid, cols, spanWide });
          for (let i = 0; i < boxes.length; i++) {
            expect(boxes[i].x + boxes[i].w).toBeLessThanOrEqual(grid.width + 1e-6);
            for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `${seed}/${cols}: ${i} ${j}`).toBe(false);
          }
        }
      }
    }
  });

  describe("a landscape box on two phone columns", () => {
    const phone = { width: 204, cols: 2, gap: 4, spanWide: true };

    it("spans the full width when both columns end level", () => {
      const { boxes, height } = packMasonry([1, 1, 2], phone);
      expect(boxes[2]).toEqual({ x: 0, y: 104, w: 204, h: 102 });
      expect(height).toBe(206);
    });

    it("spans from a ratio of 1.2, not below it", () => {
      expect(packMasonry([1.2], phone).boxes[0].w).toBe(204);
      expect(packMasonry([1.19], phone).boxes[0].w).toBe(100);
    });

    it("falls back to the shorter column when the columns are uneven", () => {
      const { boxes } = packMasonry([1, 0.8, 2], phone);
      expect(boxes[2]).toEqual({ x: 0, y: 104, w: 100, h: 50 });
    });

    it("spans only with two columns and only when asked", () => {
      expect(packMasonry([2], { ...phone, spanWide: false }).boxes[0].w).toBe(100);
      expect(packMasonry([2], { ...phone, width: 412, cols: 4 }).boxes[0].w).toBe(100);
    });

    it("spans when the columns differ by 4 px, not by more", () => {
      // Columns end at 104 and 100 + 4 + 4 = 108: 4 apart.
      const level = packMasonry([1, 100 / 104, 2], phone).boxes[2];
      expect(level.w).toBe(204);
      expect(level.y).toBeCloseTo(108, 6);
      expect(packMasonry([1, 100 / 105, 2], phone).boxes[2].w).toBe(100);
    });
  });
});
