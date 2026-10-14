"use client";

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import "./kit-controls.css";

/**
 * Asked before a paid render the balance does not cover (R29): add funds, or
 * try anyway, because /api/billing/balance answers 0 on its own errors and a
 * red balance can be wrong.
 *
 * Mount it inside the block that holds Generate: it sits above that block,
 * as wide as it, portaled at the popover layer so no scrolling column clips
 * it. Each button closes it after its action; an outside press, Esc, scroll
 * or resize close it too. For [Add funds], `openAddFunds` (lib/ui/kit/controls).
 */
export default function AddFundsPopover({ balanceUsd, totalUsd, onAddFunds, onTryAnyway, onClose }: {
  balanceUsd: number;
  /** The quote's own figure (GenerationQuote.totalUsd), shown as is. */
  totalUsd: string;
  onAddFunds: () => void;
  onTryAnyway: () => void;
  onClose: () => void;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const textId = useId();
  const dismiss = useEffectEvent(onClose);

  useLayoutEffect(() => {
    const host = anchorRef.current?.parentElement;
    const panel = panelRef.current;
    if (!host || !panel) return;
    const back = document.activeElement as HTMLElement | null;
    const r = host.getBoundingClientRect();
    Object.assign(panel.style, { left: `${r.left}px`, width: `${r.width}px`, bottom: `${window.innerHeight - r.top + 8}px` });
    panel.querySelector("button")?.focus({ preventScroll: true });
    return () => {
      if (!document.activeElement || document.activeElement === document.body) back?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const away = () => dismiss();
    const onDown = (e: PointerEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); dismiss(); }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, []);

  return (
    <>
      <span ref={anchorRef} hidden />
      {createPortal(
        <div ref={panelRef} className="kit-funds kit-focus" role="dialog" aria-labelledby={textId}>
          <p id={textId} className="kit-funds-text">
            Your balance (${balanceUsd.toFixed(2)}) is below this render (${totalUsd}).
          </p>
          <div className="kit-funds-acts">
            <button type="button" className="kit-funds-add kit-hit" onClick={() => { onAddFunds(); onClose(); }}>Add funds</button>
            <button type="button" className="kit-funds-try kit-hit" onClick={() => { onTryAnyway(); onClose(); }}>Try anyway</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
