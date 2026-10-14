/**
 * Who made an image shown under a prompt (GET /api/prompts/[id]/images
 * `maker`): the strip says their name instead of "Made with this prompt",
 * and links to their profile unless it is you (Kev, 2026-10-13).
 */
export interface Maker {
  handle: string | null;
  name: string | null;
  /** The viewer's own: named, never linked. */
  mine: boolean;
}

/** The mark over the tile: `link` opens that profile; without one the text only stands there. Null when nobody is known. */
export function makerMark(maker: Maker | undefined): { text: string; link: string | null } | null {
  if (!maker) return null;
  if (maker.mine) return { text: "You", link: null };
  if (maker.handle) return { text: `@${maker.handle}`, link: maker.handle };
  return maker.name ? { text: maker.name, link: null } : null;
}

/** What a screen reader hears for the tile. */
export function madeBy(maker: Maker | undefined): string {
  const mark = makerMark(maker);
  return !mark ? "Made by another member" : mark.text === "You" ? "Made by you" : `Made by ${mark.text}`;
}
