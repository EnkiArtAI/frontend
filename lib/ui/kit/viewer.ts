/** Paging in the fullscreen viewer (handoff §3): swipe, arrows and dots. */

/** A swipe of more than 40 px pages: to the left is the next image, to the right the previous. */
export const swipeStep = (dx: number): -1 | 0 | 1 => (dx < -40 ? 1 : dx > 40 ? -1 : 0);

/** The viewer stops at both ends; it never wraps. */
export const clampIndex = (i: number, count: number) => Math.max(0, Math.min(i, count - 1));

/** Dots only while they can be told apart: 2 to 12 images. */
export const showDots = (count: number) => count >= 2 && count <= 12;
