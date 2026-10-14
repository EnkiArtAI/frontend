/**
 * The height an autosizing textarea takes (handoff §0 "Autosize-Regel"): it
 * grows with its content between `min` and `max`, then scrolls inside. While
 * `growOnly` (values loaded from an image) it never shrinks, so the UI does
 * not jump; typing in the field clears that, and it may shrink again.
 *
 * `scrollHeight` is read with the height set to auto; `prev` is the height
 * before. Below 10 px the field is not laid out yet, and `prev` stays.
 */
export function nextHeight({ scrollHeight, prev, min, max, growOnly }: {
  scrollHeight: number;
  prev: number;
  min: number;
  max: number;
  growOnly: boolean;
}): { height: number; overflowY: "auto" | "hidden" } {
  if (scrollHeight < 10) return { height: prev, overflowY: "hidden" };
  const fit = Math.min(max, Math.max(min, scrollHeight + 2));
  const height = growOnly ? Math.max(prev, fit) : fit;
  return { height, overflowY: scrollHeight + 2 > height ? "auto" : "hidden" };
}
