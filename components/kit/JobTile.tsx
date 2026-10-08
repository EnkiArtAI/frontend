"use client";

import type { ReactNode } from "react";
import { boxRatio } from "@/lib/ui/kit/ratio";
import { tileLook, type TileStatus } from "@/lib/ui/kit/tile";
import "./kit-media.css";

/**
 * One render in a strip, a queue or a result grid (handoff §0 Render-Queue):
 * rendering is a dark tile with a spinner; ready shows the image in a turq
 * frame until it has been seen, then a ✓; failed has a danger frame and "!".
 * The ★ sits bottom-right on every surface (plan R17).
 */
export default function JobTile({ status, src, ratio, height, seen, selected, star, badge, label, onClick, children }: {
  status: TileStatus;
  src?: string;
  /** The job's own ratio ("4:5"), held between 9:16 and 16:9. */
  ratio: string | null;
  /** A strip tile: this tall and as wide as its ratio. Without it the tile fills its column. */
  height?: number;
  seen: boolean;
  /** The image shown as the main one: an ember frame. */
  selected?: boolean;
  /**
   * Stars, where a surface has them. `on` frames the tile in ember. Without
   * `onToggle` the ★ is a badge, shown while on; with it, a toggle on every
   * ready tile, and `dimmed` keeps it pressable while it looks off (the
   * caller says why), like Generate.
   */
  star?: { on: boolean; onToggle?: () => void; dimmed?: boolean; title?: string };
  badge?: "you";
  /** What the tile is, for a screen reader: "Your render, ready". */
  label: string;
  onClick?: () => void;
  /** Overlays the caller places on the tile: use values, meta, retry. */
  children?: ReactNode;
}) {
  const r = boxRatio(ratio);
  const { frame, check } = tileLook({ status, seen, selected, starred: star?.on });
  const face = status === "rendering" ? <span className="kit-spinner" aria-hidden />
    : status === "failed" ? <span className="kit-tile-bang" aria-hidden>!</span>
    : src ? <img src={src} alt="" loading="lazy" decoding="async" draggable={false} /> : null;
  const starTitle = star?.title ?? (star?.on ? "Remove star" : "Star");
  return (
    <div className="kit-tile kit-focus" data-status={status} data-frame={frame} aria-busy={status === "rendering" || undefined}
      style={height ? { width: height * r, height } : { aspectRatio: r }}>
      {onClick
        ? <button type="button" className="kit-tile-face" aria-label={label} aria-pressed={selected} onClick={onClick}>{face}</button>
        : <div className="kit-tile-face" role="img" aria-label={label}>{face}</div>}
      {badge === "you" && <span className="kit-tile-you" aria-hidden>YOU</span>}
      {check && <span className="kit-tile-check" aria-hidden>✓</span>}
      {star?.onToggle && status === "ready" ? (
        <button type="button" className="kit-tile-star kit-hit" aria-pressed={star.on} aria-disabled={star.dimmed || undefined}
          aria-label={starTitle} title={starTitle} onClick={star.onToggle}>★</button>
      ) : star?.on && <span className="kit-tile-star" aria-hidden>★</span>}
      {children}
    </div>
  );
}
