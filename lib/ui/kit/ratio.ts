/** Aspect ratios as the models table writes them ("4:5", "2.39:1"). */

/** Width over height ("4:5" → 0.8); null unless it is two positive numbers. */
export function parseRatio(ratio: string | null | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio ?? "");
  const r = m ? Number(m[1]) / Number(m[2]) : NaN;
  return r > 0 && Number.isFinite(r) ? r : null;
}

/** A tile's box: the ratio held between 9:16 and 16:9 so no tile is a sliver, 4:5 when unknown. */
export const boxRatio = (ratio: string | null | undefined) => Math.min(16 / 9, Math.max(9 / 16, parseRatio(ratio) ?? 4 / 5));
