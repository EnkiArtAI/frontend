/**
 * The one breakpoint table of the image UI. JS reads these through
 * useMediaQuery (or matchMedia in a handler); CSS repeats the same numbers.
 * The .98 edges keep a 768 / 1024 / 1200 px window on the wide side.
 */

/** Phone layout: narrow, or a phone held sideways. */
export const PHONE = "(max-width: 767.98px), (pointer: coarse) and (max-height: 500px)";
/** Editor Craft/Verify tabs, sheet instead of popover, stacked Image View. */
export const TABS = "(max-width: 1023.98px)";
/** The shell's 72 px rail. */
export const RAIL = "(max-width: 1199.98px)";
/** 44 px hit areas. */
export const COARSE = "(pointer: coarse)";
/** Card hover reveal. */
export const HOVER = "(hover: hover) and (pointer: fine)";

/** Masonry columns for a viewport `width` px wide (the feed reads innerWidth). */
export function columnsFor(width: number): 2 | 3 | 4 {
  return width >= 1400 ? 4 : width >= 1024 ? 3 : 2;
}
