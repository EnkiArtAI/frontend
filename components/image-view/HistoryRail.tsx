"use client";

import { useEffect, useEffectEvent } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { formatAgo } from "@/lib/ui/kit/format";
import type { ImageViewModel } from "./useImageViewModel";

/**
 * The viewer's own renders of this prompt, newest first (handoff §2): a
 * 196 px rail that folds to the right into a 44 px strip, or, in the stacked
 * tier, a drawer from the right edge. A render of this tab joins it only once
 * the page is left (handoff §0). No resolution and no values: no route
 * returns them (plan §5 #16).
 */
export default function HistoryRail({ model: m, drawer, open, onToggle }: {
  model: ImageViewModel;
  drawer: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { history: items, historyState: st } = m;
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

  const head = (
    <div className="iv-rail-head">
      <span className="iv-label iv-rail-label">History · {items.length}</span>
      <button type="button" className="iv-rail-toggle kit-hit" aria-expanded={open}
        aria-label={open ? "Close history" : "Open history"} title={open ? "Close history" : "Open history"} onClick={onToggle}>
        {drawer ? <X size={12} strokeWidth={2.4} aria-hidden /> : <ChevronRight size={11} strokeWidth={2.4} aria-hidden />}
      </button>
    </div>
  );
  const list = (
    <div className="iv-rail-list">
      {items.map((s) => (
        <button key={s.key} type="button" className="iv-hitem" aria-pressed={m.main?.key === s.key} onClick={() => m.select(s)}>
          <img src={s.thumb} alt="" loading="lazy" decoding="async" draggable={false} />
          <span>{formatAgo(s.createdAt ?? "", m.now)}</span>
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
            <aside className="iv-drawer" aria-label="History">{head}{list}</aside>
          </>
        )}
      </>
    );
  }
  return (
    <aside className="iv-rail" data-open={open} aria-label="History">
      {head}
      {open ? list : (
        <button type="button" className="iv-rail-mini" aria-label="Open history" onClick={onToggle}>
          {items.slice(0, 6).map((s) => (
            <span key={s.key} className="iv-mini" data-on={m.main?.key === s.key || undefined}>
              {s.thumb && <img src={s.thumb} alt="" loading="lazy" draggable={false} />}
            </span>
          ))}
          <span className="iv-rail-vert">History</span>
        </button>
      )}
    </aside>
  );
}
