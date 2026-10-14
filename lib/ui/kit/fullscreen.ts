/** The fullscreen viewer's input decisions (components/kit/FullscreenViewer). */
import { parseRatio } from "./ratio";
import { swipeStep } from "./viewer";

export type ViewerAct = "close" | "prev" | "next";

/**
 * What a key does to the viewer. Nothing while a bottom sheet is open over
 * it (both listen on window in the capture phase, and the viewer, opened
 * first, would hear Esc first) or while focus sits in something outside it,
 * such as the report dialog. The arrows never page while the user types.
 */
export function viewerKey(key: string, at: { sheet: boolean; inside: boolean; typing: boolean }): ViewerAct | null {
  if (at.sheet || !at.inside) return null;
  if (key === "Escape") return "close";
  if (at.typing) return null;
  return key === "ArrowLeft" ? "prev" : key === "ArrowRight" ? "next" : null;
}

/** A swipe pages only when it went more sideways than up or down: a scroll is not a swipe. */
export const swipeOf = (dx: number, dy: number) => (Math.abs(dx) > Math.abs(dy) ? swipeStep(dx) : 0);

/** The image box's width over height: the picture's own once loaded, the asked ratio before, square when neither is known. */
export const viewerRatio = (natural: number | undefined, ratio: string | null | undefined) => natural ?? parseRatio(ratio) ?? 1;
