/** What the kit's tiles show of their state: render jobs (JobTile) and reference images (ReferenceTiles). */

export type TileStatus = "rendering" | "ready" | "failed";
export type TileFrame = "ember" | "danger" | "turq" | "none";

/**
 * A job tile's frame, first match wins: the selected or starred image is
 * ember, a failed render danger, and a finished render turq until it has
 * been seen (handoff §0 Render-Queue). A seen render wears a ✓ instead.
 */
export function tileLook({ status, seen, selected = false, starred = false }: {
  status: TileStatus;
  seen: boolean;
  selected?: boolean;
  starred?: boolean;
}): { frame: TileFrame; check: boolean } {
  const frame = selected || starred ? "ember" : status === "failed" ? "danger" : status === "ready" && !seen ? "turq" : "none";
  return { frame, check: status === "ready" && seen };
}

/** How many more references fit: the cap less the images in and those still being read. */
export const refRoom = (cap: number, taken: number) => Math.max(0, cap - taken);

/** The token the i-th reference tile drops into a prompt. */
export const refToken = (i: number) => `[Reference image ${i + 1}]`;

/** Which side of tile `to` the bar marks while tile `from` is dragged over it: the side it will land on. */
export const dropSide = (from: number, to: number) => (to === from ? null : to < from ? "before" : "after");
