"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { lockScroll, trapStep } from "@/lib/ui/kit/controls";
import { swipeOf, viewerKey, viewerRatio } from "@/lib/ui/kit/fullscreen";
import { clampIndex, showDots } from "@/lib/ui/kit/viewer";
import "./kit-media.css";

export interface ViewerItem {
  key: string;
  /** Absent for a failed render. */
  src?: string;
  /** The ratio asked for ("4:5"), until the picture has loaded and says its own. */
  ratio?: string | null;
  /** The whole sentence the failure is told with. */
  failed?: { message: string };
}

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Every finished image, one at a time, over everything but sheets and
 * dialogs (z 9999, the level report-ui.test pins). ← → and a sideways swipe
 * of more than 40 px page and stop at both ends; Esc, × and the backdrop
 * close, and Esc closes the viewer alone. A tap on the picture does
 * nothing, and the picture is a plain <img>, so a long press saves it. The
 * box takes its height from the screen and its width from the ratio, so
 * the picture is never squashed.
 *
 * Focus stays inside while it is open and goes back to the opener; the page
 * behind does not scroll. The caller holds the index and supplies the
 * panel: values, meta and actions.
 */
export default function FullscreenViewer({ items, index, onIndex, onClose, layout, nav, top, panel }: {
  items: ViewerItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: (lastIndex: number) => void;
  /** "side": the panel on the right (desktop). "stacked": under the picture (phone, tablet). */
  layout: "side" | "stacked";
  /** "thumbs": a strip at the bottom that shows on hover. "dots": one per image, for 2 to 12. */
  nav: "thumbs" | "dots";
  /** Replaces the "3 / 12" counter at the top left. */
  top?: ReactNode;
  panel: ReactNode;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const closer = useRef<HTMLButtonElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const [natural, setNatural] = useState<Record<string, number>>({});
  const count = items.length;
  const at = clampIndex(index, count);
  const item = items[at];

  const go = (step: number) => {
    const next = clampIndex(at + step, count);
    if (next !== at) onIndex(next);
  };
  const close = () => onClose(at);
  const learn = (key: string) => (e: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    if (w && h) setNatural((n) => (n[key] === w / h ? n : { ...n, [key]: w / h }));
  };

  const onKey = useEffectEvent((e: globalThis.KeyboardEvent) => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    const act = viewerKey(e.key, {
      sheet: !!document.querySelector(".kit-sheet-layer"),
      inside: !t || t === document.body || !!layer.current?.contains(t),
      typing: !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)),
    });
    if (!act) return;
    // Capture phase: the page's own Esc (EnkiDetailPanel) never hears it.
    e.stopPropagation();
    e.preventDefault();
    if (act === "close") close();
    else go(act === "next" ? 1 : -1);
  });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closer.current?.focus({ preventScroll: true });
    const release = lockScroll(document.documentElement, window.innerWidth);
    const key = (e: globalThis.KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      release();
      if (!document.activeElement || document.activeElement === document.body) opener?.focus({ preventScroll: true });
    };
  }, []);

  // The current thumb stays in view as the viewer pages.
  useLayoutEffect(() => {
    const s = strip.current;
    const thumb = s?.querySelector<HTMLElement>('[aria-current="true"]');
    if (s && thumb) s.scrollLeft = thumb.offsetLeft - (s.clientWidth - thumb.offsetWidth) / 2;
  }, [at]);

  if (!item) return null;

  const trap = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys from a sheet or dialog opened inside reach here through React, not through the page.
    if (e.key !== "Tab" || !e.currentTarget.contains(e.target as Node)) return;
    e.preventDefault();
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (all.length) all[trapStep(all.indexOf(document.activeElement as HTMLElement), all.length, e.shiftKey)].focus();
  };
  const backdrop = (e: SyntheticEvent) => {
    if (e.target === e.currentTarget) close();
  };

  return createPortal(
    <div ref={layer} className="kit-viewer kit-focus" data-layout={layout} role="dialog" aria-modal="true"
      aria-label={`${at + 1} of ${count}`} onClick={backdrop} onKeyDown={trap}>
      <div className="kit-viewer-top">
        {top ?? <span className="kit-viewer-count">{at + 1} / {count}</span>}
        <button ref={closer} type="button" className="kit-viewer-x kit-hit" aria-label="Close" onClick={close}>
          <X size={15} strokeWidth={2.2} />
        </button>
      </div>
      <div className="kit-viewer-stage" onClick={backdrop}>
        <div className="kit-viewer-box" data-failed={item.failed ? "" : undefined}
          style={{ "--r": viewerRatio(natural[item.key], item.ratio) } as CSSProperties}
          onPointerDown={(e) => { swipe.current = { x: e.clientX, y: e.clientY }; }}
          onPointerUp={(e) => {
            const s = swipe.current;
            swipe.current = null;
            if (s) go(swipeOf(e.clientX - s.x, e.clientY - s.y));
          }}
          onPointerCancel={() => { swipe.current = null; }}>
          {item.failed ? (
            <div className="kit-viewer-failed">
              <span className="kit-viewer-bang" aria-hidden>!</span>
              {item.failed.message}
            </div>
          ) : item.src && (
            <img key={item.key} src={item.src} alt="" draggable={false} onLoad={learn(item.key)} />
          )}
          {count > 1 && (
            <>
              <button type="button" className="kit-viewer-nav kit-hit" data-dir="prev" aria-label="Previous image"
                aria-disabled={at === 0 || undefined} onClick={() => go(-1)}>
                <ChevronLeft size={14} strokeWidth={2.4} />
              </button>
              <button type="button" className="kit-viewer-nav kit-hit" data-dir="next" aria-label="Next image"
                aria-disabled={at === count - 1 || undefined} onClick={() => go(1)}>
                <ChevronRight size={14} strokeWidth={2.4} />
              </button>
            </>
          )}
        </div>
        {nav === "thumbs" && count > 1 && (
          <div className="kit-viewer-thumbzone">
            <div ref={strip} className="kit-viewer-thumbs kit-noscroll">
              {items.map((it, i) => (
                <button key={it.key} type="button" className="kit-viewer-thumb" aria-label={`Image ${i + 1}`}
                  aria-current={i === at || undefined} onClick={() => onIndex(i)}
                  style={{ "--r": viewerRatio(natural[it.key], it.ratio) } as CSSProperties}>
                  {it.src ? <img src={it.src} alt="" loading="lazy" draggable={false} onLoad={learn(it.key)} /> : <span aria-hidden>!</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {nav === "dots" && showDots(count) && (
        <div className="kit-viewer-dots" aria-hidden>
          {items.map((it, i) => <span key={it.key} data-on={i === at || undefined} />)}
        </div>
      )}
      <div className="kit-viewer-panel kit-noscroll">{panel}</div>
    </div>,
    document.body,
  );
}
