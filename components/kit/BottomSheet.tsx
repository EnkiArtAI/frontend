"use client";

import { useEffect, useEffectEvent, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { lockScroll, sheetDragCloses, trapStep } from "@/lib/ui/kit/controls";
import "./kit-controls.css";

/** Matches .kit-sheet-layer.is-closing in kit-controls.css. */
const OUT_MS = 260;
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A sheet that slides up from the bottom of the screen (handoff §3): every
 * picker below 1024 px, and the phone's bookmark sheet.
 *
 * It stays mounted for the slide down after `open` turns false, and lets taps
 * through while it goes. The page behind is locked without moving by a pixel,
 * focus is kept inside, and it returns to where it was once the sheet is
 * gone. Esc closes this sheet only.
 */
export default function BottomSheet({ open, title, hint, onClose, children }: {
  open: boolean;
  title: string;
  hint?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  const closing = shown && !open;
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const titleId = useId();
  const dismiss = useEffectEvent(onClose);

  // Reopening during the slide down cancels the unmount.
  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(() => setShown(false), OUT_MS);
    return () => clearTimeout(t);
  }, [closing]);

  // A drag that ended in a close leaves its offset for the slide down;
  // reopening the same sheet starts from the bottom edge again.
  useEffect(() => {
    if (open) panelRef.current?.style.removeProperty("translate");
  }, [open]);

  useEffect(() => {
    if (!shown) return;
    const back = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>('[aria-selected="true"]') ?? panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel)
      ?.focus({ preventScroll: true });
    const release = lockScroll(document.documentElement, window.innerWidth);
    return () => {
      release();
      // Not when another sheet or field took focus in the meantime.
      if (!document.activeElement || document.activeElement === document.body) back?.focus({ preventScroll: true });
    };
  }, [shown]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); dismiss(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!shown) return null;

  const trap = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (all.length) all[trapStep(all.indexOf(document.activeElement as HTMLElement), all.length, e.shiftKey)].focus();
  };
  const grab = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, dy: 0 };
  };
  const pull = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !panelRef.current) return;
    d.dy = Math.max(0, e.clientY - d.y);
    panelRef.current.style.translate = `0 ${d.dy}px`;
  };
  const letGo = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (sheetDragCloses(d.dy)) onClose();
    else panelRef.current?.style.removeProperty("translate");
  };

  return createPortal(
    <div className={`kit-sheet-layer${closing ? " is-closing" : ""}`}>
      <div className="kit-sheet-backdrop" onClick={onClose} />
      <div ref={panelRef} className="kit-sheet kit-focus" role="dialog" aria-modal="true" aria-labelledby={titleId}
        tabIndex={-1} onKeyDown={trap}>
        <div className="kit-sheet-grab" aria-hidden
          onPointerDown={grab} onPointerMove={pull} onPointerUp={letGo} onPointerCancel={letGo} />
        <div className="kit-sheet-head">
          <span id={titleId} className="kit-sheet-title">{title}</span>
          {hint && <span className="kit-sheet-hint">{hint}</span>}
        </div>
        <div className="kit-sheet-body kit-noscroll">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
