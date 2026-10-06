/**
 * How the social preview card tiles a prompt's showcase images (Kev,
 * 2026-09-05): PORTRAIT renders stand side by side — four tall cells suit
 * tall pictures — while square or landscape renders fill a 2×2:
 *
 *   portrait   →  1 2 3 4        square/landscape →  1 2
 *                                                     3 4
 *
 * Two landscape images split the card left/right; three take two on top
 * and the third spanning the bottom (the last cell spans the full width).
 */
export interface GridCell { x: number; y: number; w: number; h: number }

/** Parse "3:4" / "16:9" / "1:1" into width÷height; unknown → 1 (square). */
export function aspectOf(ratio: string | null | undefined): number {
  const m = String(ratio ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i);
  if (!m) return 1;
  const w = Number(m[1]), h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : 1;
}

export function gridFor(count: number, aspect: number, width: number, height: number): GridCell[] {
  const n = Math.max(0, Math.min(4, Math.floor(count)));
  if (n === 0) return [];
  const portrait = aspect < 0.9;
  if (portrait || n === 1) {
    // One row: 1..4 tall cells (a single image of any shape fills the card).
    const w = width / n;
    return Array.from({ length: n }, (_, i) => ({ x: i * w, y: 0, w, h: height }));
  }
  if (n === 2) {
    const w = width / 2;
    return [{ x: 0, y: 0, w, h: height }, { x: w, y: 0, w, h: height }];
  }
  // 3 or 4: 2×2; with three, the last spans the bottom row.
  const w = width / 2, h = height / 2;
  const cells: GridCell[] = [
    { x: 0, y: 0, w, h },
    { x: w, y: 0, w, h },
  ];
  if (n === 3) cells.push({ x: 0, y: h, w: width, h });
  else cells.push({ x: 0, y: h, w, h }, { x: w, y: h, w, h });
  return cells;
}
