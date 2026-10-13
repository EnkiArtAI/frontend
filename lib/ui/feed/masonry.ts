export interface Box { x: number; y: number; w: number; h: number }

/** A box this wide spans both phone columns, when they end this level. */
const WIDE = 1.2;
const LEVEL = 4;

/**
 * The feed's masonry: each box, in feed order, goes into the shortest column
 * (ties to the left). A box depends only on the ones before it, so appending
 * a page never moves a placed card, which CSS columns would re-balance under
 * the reader. With `spanWide` (two phone columns) a landscape box takes the
 * full width when both columns end level, so it never leaves a hole.
 * `ratios` are width over height; positions stay floats until render.
 */
export function packMasonry(
  ratios: readonly number[],
  { width, cols, gap, spanWide }: { width: number; cols: number; gap: number; spanWide: boolean },
): { boxes: Box[]; height: number } {
  const colW = (width - gap * (cols - 1)) / cols;
  const heights = new Array<number>(cols).fill(0);
  const boxes = ratios.map((r) => {
    if (spanWide && cols === 2 && r >= WIDE && Math.abs(heights[0] - heights[1]) <= LEVEL) {
      const y = Math.max(...heights);
      const h = width / r;
      heights.fill(y + h + gap);
      return { x: 0, y, w: width, h };
    }
    const c = heights.indexOf(Math.min(...heights));
    const box = { x: c * (colW + gap), y: heights[c], w: colW, h: colW / r };
    heights[c] += box.h + gap;
    return box;
  });
  return { boxes, height: boxes.length ? Math.max(...heights) - gap : 0 };
}
