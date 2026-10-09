"use client";

import JobTile from "@/components/kit/JobTile";
import type { EditorSetup } from "@/lib/editor/generate-checks";
import { canStar, type Stars } from "@/lib/editor/variations";
import type { Job } from "@/lib/ui/kit/render-queue";

export type EditorJob = Job<EditorSetup>;

/** What a result tile does: open it (a failed one shows its setup and Retry), load its values, star it. */
export interface TileActs {
  stars: Stars;
  open: (job: EditorJob) => void;
  load: (job: EditorJob) => void;
  star: (id: string) => void;
}

/**
 * One render in Verify, at its own ratio (plan R17): ★ bottom-right; top-left
 * "← use values" from 1024 px ("↩" on a narrow tile) and "Open" below; the
 * settings it was made with along the bottom. A failed render opens its setup
 * with Retry rather than paying again at once (handoff §0).
 */
export default function ResultTile({ job, acts }: { job: EditorJob; acts: TileActs }) {
  const s = job.setup;
  const on = acts.stars[job.id] !== undefined;
  const stored = canStar(job);
  return (
    <JobTile status={job.status} src={job.imageUrl} ratio={s.ratio} seen={job.seen}
      star={{
        on,
        onToggle: () => acts.star(job.id),
        dimmed: !on && !stored,
        title: on ? "Starred for release · click to unstar" : stored ? "Star for release" : "This render wasn't stored, so it can't be a showcase image",
      }}
      label={job.status === "rendering" ? "Rendering" : job.status === "failed" ? "Render failed · open to retry" : `${s.resolution} · ${s.modelName} · open`}
      onClick={job.status === "rendering" ? undefined : () => acts.open(job)}>
      {job.status === "ready" && (
        <>
          <button type="button" className="pe-tile-pill pe-wide-only" title="Put this image's values into the editor" onClick={() => acts.load(job)}>
            <span className="pe-long">← use values</span>
            <span className="pe-short" aria-hidden>↩</span>
          </button>
          <button type="button" className="pe-tile-pill pe-tabs-only" onClick={() => acts.open(job)}>Open</button>
          <span className="pe-tile-meta">{s.resolution} · {s.modelName}</span>
        </>
      )}
      {job.status === "failed" && (
        <button type="button" className="pe-tile-retry kit-hit" title={job.error?.message} onClick={() => acts.open(job)}>
          Failed · retry{job.error?.charged === "no" ? " (not charged)" : ""}
        </button>
      )}
    </JobTile>
  );
}
