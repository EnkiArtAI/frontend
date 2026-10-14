"use client";

import type { ReactNode } from "react";
import type { Variation } from "@/lib/editor/variations";
import type { PaneProps } from "./EditorHeader";
import type { TileActs } from "./ResultTile";
import VariationGroup from "./VariationGroup";

/**
 * Verify: every render by variation, newest first, small enough that several
 * variations show at once (handoff §4); the release bar at the bottom. Four
 * columns at most (three for a wide ratio), three on a tablet, two on a phone.
 */
export default function VerifyPane({ pane, groups, need, wide, open, onToggle, onLoad, acts, onCraft, showcase, release }: {
  /** Its id, and below 1024 px its role as the Verify tab's panel. */
  pane: PaneProps;
  groups: Variation[];
  need: number;
  /** The current ratio is wider than tall. */
  wide: boolean;
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onLoad: (group: Variation) => void;
  acts: TileActs;
  onCraft: () => void;
  /** The live images of a loaded prompt (E2). */
  showcase: ReactNode;
  release: ReactNode;
}) {
  return (
    <div className="pe-verify" data-wide={wide || undefined} {...pane}>
      <div className="pe-results">
        {!groups.length && (
          <div className="pe-blank">
            <span className="kit-title pe-blank-title">Your test images show up here.</span>
            <span className="pe-blank-text">
              Hit Generate, look at the results, fix your prompt, repeat. When you like a set, star {need === 1 ? "1 image" : `${need} images`} and release.
            </span>
            <button type="button" className="pe-blank-back pe-tabs-only" onClick={onCraft}>← Back to Craft</button>
          </div>
        )}
        {groups.map((g) => (
          <VariationGroup key={g.key} group={g} open={open} onToggle={onToggle} onLoad={() => onLoad(g)} acts={acts} />
        ))}
        {showcase}
      </div>
      {release}
    </div>
  );
}
