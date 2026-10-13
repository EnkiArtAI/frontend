"use client";

import { useLayoutEffect, useRef } from "react";
import JobTile from "@/components/kit/JobTile";
import type { EditorSetup } from "@/lib/editor/generate-checks";
import type { Stars } from "@/lib/editor/variations";
import type { Job } from "@/lib/ui/kit/render-queue";

/** How many of the newest renders the strip holds. */
const SHOWN = 12;

/**
 * The newest renders above Generate, below 1024 px only, where Verify is a
 * tab away (handoff §5): the user stays in Craft. A new render comes in at
 * the front; a strip scrolled away from the start keeps the tile in view.
 */
export default function LiveStrip({ jobs, stars, onOpen, onCancel, onAll }: {
  /** Newest first, as the queue holds them. */
  jobs: Job<EditorSetup>[];
  stars: Stars;
  onOpen: (job: Job<EditorSetup>) => void;
  onCancel: (id: string) => void;
  onAll: () => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const first = jobs[0]?.id;
  const was = useRef(first);
  useLayoutEffect(() => {
    const s = strip.current;
    if (s && first !== was.current && s.scrollLeft >= 8) {
      s.scrollLeft += ((s.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0) + 8;
    }
    was.current = first;
  }, [first]);

  if (!jobs.length) return null;
  const rendering = jobs.filter((j) => j.status === "rendering").length;
  return (
    <div className="pe-live pe-tabs-only">
      <div className="pe-live-head">
        <span className="pe-live-label">
          {rendering ? `Rendering ${rendering}… · ${jobs.length} total` : `Latest · ${jobs.length} image${jobs.length === 1 ? "" : "s"}`}
        </span>
        <button type="button" className="pe-add kit-hit" onClick={onAll}>All results →</button>
      </div>
      <div ref={strip} className="pe-live-strip kit-noscroll">
        {jobs.slice(0, SHOWN).map((j) => (
          <JobTile key={j.id} status={j.status} sent={j.sent} src={j.imageUrl} ratio={j.setup.ratio} height={72} seen={j.seen}
            star={stars[j.id] !== undefined ? { on: true } : undefined}
            label={j.status === "rendering" ? "Rendering" : j.status === "failed" ? "Render failed · open to retry" : "Render, open it"}
            onClick={j.status === "rendering" ? undefined : () => onOpen(j)} onCancel={() => onCancel(j.id)} />
        ))}
      </div>
    </div>
  );
}
