"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import JobTile from "@/components/kit/JobTile";
import { jobSaid } from "@/lib/ui/image-view/setups";
import type { ImageViewModel, Shot } from "./useImageViewModel";

type Edges = { start: boolean; end: boolean };

/** Whether the row can scroll further back or on; the same object when that did not change. */
const edgesOf = (r: HTMLElement) => (e: Edges): Edges => {
  const start = r.scrollLeft <= 1;
  const end = r.scrollLeft + r.clientWidth >= r.scrollWidth - 1;
  return start === e.start && end === e.end ? e : { start, end };
};

/**
 * Under the stage (handoff §2): the creator's examples, then public images
 * made with the prompt. A click puts one on the stage. This tab's renders are
 * in the History rail (Kev, 2026-10-13: "not under the main image"); only
 * where there is no rail (`queue`: the stacked tier, the blank composer) do
 * they lead this row (newest first, "YOU", turq until seen, then ✓), and a
 * new one scrolls it back to its start.
 */
export default function PreviewStrip({ model: m, queue }: { model: ImageViewModel; queue: boolean }) {
  const row = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>({ start: true, end: true });
  const count = queue ? m.jobs.length : 0;
  const tiles = [...m.examples, ...m.community];
  const shown = count > 0 || tiles.length > 0;

  useEffect(() => {
    const r = row.current;
    if (!r || !track.current) return;
    // The track grows with its tiles, the row with the column: either can change what fits.
    const ro = new ResizeObserver(() => setEdges(edgesOf(r)));
    ro.observe(r);
    ro.observe(track.current);
    return () => ro.disconnect();
  }, [shown]);
  useEffect(() => {
    row.current?.scrollTo({ left: 0 });
  }, [count]);

  if (!shown) return null;
  const scroll = (by: number) => row.current?.scrollBy({ left: by, behavior: "smooth" });
  const on = (s: Shot) => m.main?.key === s.key;
  const newest = queue ? m.jobs[0] : undefined;

  return (
    <div className="iv-strip">
      <button type="button" className="iv-strip-arrow kit-hit" aria-label="Scroll left" disabled={edges.start} onClick={() => scroll(-240)}>
        <ChevronLeft size={11} strokeWidth={2.4} aria-hidden />
      </button>
      <div ref={row} className="iv-strip-row kit-noscroll" onScroll={(e) => setEdges(edgesOf(e.currentTarget))}>
        <div ref={track} className="iv-strip-track">
          {queue && m.queue.map((s) => s.job && (
            <JobTile key={s.key} status={s.job.status} src={s.src} ratio={s.ratio} height={64} seen={s.job.seen} selected={on(s)}
              badge="you" label={`Your render, ${jobSaid(s.job)}`} onClick={() => m.select(s)} />
          ))}
          {tiles.map((s, i) => (
            <button key={s.key} type="button" className="iv-thumb" aria-pressed={on(s)} onClick={() => m.select(s)}
              aria-label={s.kind === "example" ? `Creator example ${i + 1}` : `Made with this prompt ${i - m.examples.length + 1}`}
              title={s.kind === "example" ? "Creator example" : "Made with this prompt"}>
              <img src={s.thumb} alt="" loading="lazy" decoding="async" draggable={false} />
            </button>
          ))}
        </div>
      </div>
      <button type="button" className="iv-strip-arrow kit-hit" aria-label="Scroll right" disabled={edges.end} onClick={() => scroll(240)}>
        <ChevronRight size={11} strokeWidth={2.4} aria-hidden />
      </button>
      <span className="iv-sr" role="status">{!newest ? "" : newest.status === "rendering" ? "Rendering…" : `Render ${jobSaid(newest)}`}</span>
    </div>
  );
}
