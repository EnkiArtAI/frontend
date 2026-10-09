"use client";

import JobTile from "@/components/kit/JobTile";
import { varNames } from "@/lib/editor/prompt-tokens";
import ResultTile, { type EditorJob, type TileActs } from "./ResultTile";

/**
 * Renders with the same values (handoff §4). Closed: the newest on top at full
 * size, two cards fanned down and right behind it (showing their images once
 * they have one), a count, and a ★ when any of them is starred; a click opens
 * it. Open: a tray across the row, tinted in the variation's colour, with
 * every render; a click on the tray itself closes it again.
 */
export default function StackCard({ jobs, open, onToggle, acts }: {
  /** Newest first, two or more. */
  jobs: EditorJob[];
  open: boolean;
  onToggle: () => void;
  acts: TileActs;
}) {
  const top = jobs[0];
  if (open) {
    const s = top.setup;
    const values = varNames(s.prompt).map((n) => `${n || "unnamed"}: ${s.vars[n] ?? ""}`).join(" · ");
    const self = (e: { target: unknown; currentTarget: unknown }) => e.target === e.currentTarget && onToggle();
    return (
      <div className="pe-tray" onClick={self}>
        <div className="pe-tray-head">
          <span className="pe-tray-n">▣ {jobs.length} images · same values</span>
          <span className="pe-tray-values">{values}</span>
          <button type="button" className="pe-tray-x kit-hit" onClick={onToggle}>Collapse ▴</button>
        </div>
        <div className="pe-grid" onClick={self}>
          {jobs.map((j) => <ResultTile key={j.id} job={j} acts={acts} />)}
        </div>
      </div>
    );
  }
  return (
    <button type="button" className="pe-stack" title={`${jobs.length} images with the same values · click to open`} onClick={onToggle}>
      {/* The furthest card first, so the nearer one paints over it. */}
      {jobs.slice(1, 3).map((j, i) => (
        <span key={j.id} className="pe-deck" data-layer={i + 1} aria-hidden>
          {j.status === "ready" && j.imageUrl && <img src={j.imageUrl} alt="" />}
        </span>
      )).reverse()}
      <JobTile status={top.status} src={top.imageUrl} ratio={top.setup.ratio} seen={top.seen} label={`${jobs.length} images with the same values`} />
      <span className="pe-stack-n">▣ {jobs.length}</span>
      {jobs.some((j) => acts.stars[j.id] !== undefined) && <span className="pe-stack-star" aria-hidden>★</span>}
    </button>
  );
}
