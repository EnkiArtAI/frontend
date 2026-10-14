"use client";

import { openCreator } from "@/lib/openCreator";
import { makerMark, type Maker } from "@/lib/ui/image-view/maker";

/**
 * The maker's name over an image made with the prompt (Kev, 2026-10-13):
 * shown on hover or focus (always on a touch screen), a link to their
 * profile unless it is you. A sibling of the tile's button, never inside it.
 */
export default function MakerMark({ maker }: { maker: Maker | undefined }) {
  const mark = makerMark(maker);
  if (!mark) return null;
  return mark.link ? (
    <button type="button" className="iv-thumb-by kit-hit" title={`Open ${mark.text}'s profile`} onClick={() => openCreator(mark.link as string)}>
      {mark.text}
    </button>
  ) : (
    <span className="iv-thumb-by" aria-hidden>{mark.text}</span>
  );
}
