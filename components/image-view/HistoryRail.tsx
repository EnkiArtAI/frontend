"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import JobTile from "@/components/kit/JobTile";
import { jobSaid } from "@/lib/ui/image-view/setups";
import { formatAgo } from "@/lib/ui/kit/format";
import type { ImageViewModel, Shot } from "./useImageViewModel";

/** This tab's renders lead the rail from the moment they start; a recorded one is already among the history under the same key. */
export function railItems(queue: Shot[], history: Shot[]): Shot[] {
  const listed = new Set(history.map((s) => s.key));
  return [...queue.filter((s) => !listed.has(s.key)), ...history];
}

/** Under a rail entry: how long ago it was made, or where a render of this tab stands. */
const when = (s: Shot, now: number) =>
  s.createdAt ? formatAgo(s.createdAt, now)
    : s.job?.status === "rendering" ? "Rendering…" : s.job?.status === "failed" ? "Failed" : "Just now";

/**
 * The viewer's own renders of this prompt, newest first (handoff §2): a
 * 196 px rail that folds to the right into a 44 px strip, or, in the stacked
 * tier, a drawer from the right edge. A render of this tab is in it from the
 * moment it starts, not under the stage (Kev, 2026-10-13): rendering, failed
 * or ready, then with its time once the server has recorded it. No resolution
 * and no values: no route returns them (plan §5 #16).
 */
export default function HistoryRail({ model: m, drawer, open, onToggle }: {
  model: ImageViewModel;
  drawer: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { historyState: st } = m;
  const items = railItems(m.queue, m.history);
  const toggle = useEffectEvent(onToggle);
  // An open drawer is the top layer: Esc closes it, not the page.
  useEffect(() => {
    if (!drawer || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      toggle();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drawer, open]);
  // A new render starts at the top of the rail: it comes back into view.
  const list = useRef<HTMLDivElement>(null);
  const count = m.jobs.length;
  useEffect(() => {
    list.current?.scrollTo({ top: 0 });
  }, [count]);
  const newest = m.jobs[0];

  const head = (
    <div className="iv-rail-head">
      <span className="iv-label iv-rail-label">History · {items.length}</span>
      <button type="button" className="iv-rail-toggle kit-hit" aria-expanded={open}
        aria-label={open ? "Close history" : "Open history"} title={open ? "Close history" : "Open history"} onClick={onToggle}>
        {drawer ? <X size={12} strokeWidth={2.4} aria-hidden /> : <ChevronRight size={11} strokeWidth={2.4} aria-hidden />}
      </button>
    </div>
  );
  const rows = (
    <div ref={list} className="iv-rail-list">
      {items.map((s) => s.job ? (
        <div key={s.key} className="iv-hitem">
          <JobTile status={s.job.status} src={s.thumb ?? s.src} ratio={s.ratio} seen={s.job.seen} selected={m.main?.key === s.key}
            label={`Your render, ${jobSaid(s.job)}`} onClick={() => m.select(s)} />
          <span>{when(s, m.now)}</span>
        </div>
      ) : (
        <button key={s.key} type="button" className="iv-hitem" aria-pressed={m.main?.key === s.key} onClick={() => m.select(s)}>
          <img src={s.thumb} alt="" loading="lazy" decoding="async" draggable={false} />
          <span>{when(s, m.now)}</span>
        </button>
      ))}
      {st.loading ? <p className="iv-rail-note">Loading…</p>
        : st.failed ? <p className="iv-rail-note">Your renders could not load. <button type="button" className="iv-link" onClick={st.retry}>Try again</button></p>
        : !items.length && <p className="iv-rail-note">No renders of this prompt yet</p>}
      {st.more && (
        <button type="button" className="iv-older kit-hit" disabled={st.loadingOlder} onClick={st.loadOlder}>
          {st.loadingOlder ? "Loading…" : "Load older"}
        </button>
      )}
    </div>
  );

  if (drawer) {
    return (
      <>
        <button type="button" className="iv-drawer-handle kit-hit" aria-label="Open history" aria-expanded={open} onClick={onToggle}>
          <ChevronLeft size={14} strokeWidth={2.4} aria-hidden />
        </button>
        {open && (
          <>
            <div className="iv-drawer-scrim" onClick={onToggle} />
            <aside className="iv-drawer" aria-label="History">{head}{rows}</aside>
          </>
        )}
      </>
    );
  }
  return (
    <aside className="iv-rail" data-open={open} aria-label="History">
      {head}
      {open ? rows : (
        <button type="button" className="iv-rail-mini" aria-label="Open history" onClick={onToggle}>
          {items.slice(0, 6).map((s) => (
            <span key={s.key} className="iv-mini" data-on={m.main?.key === s.key || undefined} data-status={s.job?.status}>
              {(s.thumb ?? s.src) && <img src={s.thumb ?? s.src} alt="" loading="lazy" draggable={false} />}
            </span>
          ))}
          <span className="iv-rail-vert">History</span>
        </button>
      )}
      {/* The rail holds the queue here, so it also says where the newest render stands (the strip does where there is no rail). */}
      <span className="iv-sr" role="status">{!newest ? "" : newest.status === "rendering" ? "Rendering…" : `Render ${jobSaid(newest)}`}</span>
    </aside>
  );
}
