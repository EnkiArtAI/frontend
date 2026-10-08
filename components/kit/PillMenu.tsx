"use client";

import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePanelPos, panelStyle } from "./panel-pos";
import BottomSheet from "./BottomSheet";
import { menuMode, placeMenu } from "@/lib/ui/kit/controls";
import "./kit-controls.css";

export interface MenuOption {
  key: string;
  label: ReactNode;
  /** Right-aligned detail in mono: a price, "primary", "not on Flux". */
  sub?: string | null;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
}

/**
 * Every picker of the image UI: a pill that opens its options as a popover
 * from 1024 px up and as a bottom sheet below (asked when it opens, so render
 * output never depends on the width). The popover is portaled and fixed
 * (usePanelPos), measured before paint onto the side asked for and inside the
 * viewport, and closes on an outside press, Esc, scroll or resize.
 */
export default function PillMenu({
  trigger, ariaLabel, title, hint, options, value, onPick, columns = 1, direction, disabled = false,
}: {
  /** The pill's face; the caret is added. */
  trigger: ReactNode;
  /** Also the pill's hover text: several pills show only an icon. */
  ariaLabel: string;
  title: string;
  hint?: string;
  options: MenuOption[];
  value: string | null;
  onPick: (key: string) => void;
  columns?: 1 | 2;
  direction?: "up" | "down";
  disabled?: boolean;
}) {
  // usePanelPos's own row estimate only seeds the first frame: the layout
  // effect below measures and places the panel before it is painted.
  const { pos, open, toggle, close, trigRef, wrapRef, panelRef } = usePanelPos(options.length);
  const [sheet, setSheet] = useState(false);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const trig = trigRef.current;
    if (!pos || !panel || !trig) return;
    const at = placeMenu(
      trig.getBoundingClientRect(),
      { width: panel.offsetWidth, height: panel.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
      direction,
    );
    Object.assign(panel.style, {
      left: `${at.left}px`,
      top: at.top === undefined ? "" : `${at.top}px`,
      bottom: at.bottom === undefined ? "" : `${at.bottom}px`,
      maxHeight: `${at.maxHeight}px`,
    });
    (panel.querySelector<HTMLElement>('[aria-selected="true"]:not(:disabled)') ?? panel.querySelector<HTMLElement>("button:not(:disabled)"))
      ?.focus({ preventScroll: true });
    return () => {
      if (!document.activeElement || document.activeElement === document.body) trig.focus({ preventScroll: true });
    };
  }, [pos, direction, panelRef, trigRef]);

  const pick = (key: string) => {
    onPick(key);
    close();
    setSheet(false);
  };
  const list = (
    <div className={`kit-opts${columns === 2 ? " kit-opts--2" : ""}`} role="listbox" aria-label={title}>
      {options.map((o) => (
        <button key={o.key} type="button" role="option" aria-selected={o.key === value} disabled={o.disabled}
          title={o.title} className="kit-opt" onClick={() => pick(o.key)}>
          {o.icon}
          <span>{o.label}</span>
          {o.sub && <span className="kit-opt-sub">{o.sub}</span>}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={wrapRef} className="kit-menu">
      <button ref={trigRef} type="button" className="kit-pill kit-hit kit-focus" aria-label={ariaLabel} title={ariaLabel}
        aria-haspopup="listbox" aria-expanded={open || sheet} disabled={disabled}
        onClick={() => (menuMode(window) === "sheet" ? setSheet(true) : toggle())}>
        {trigger}
        <span className="kit-caret" aria-hidden>▾</span>
      </button>
      {pos && createPortal(
        <div ref={panelRef} className="kit-menu-panel kit-focus" style={panelStyle(pos)}>
          <div className="kit-menu-head"><span>{title}</span>{hint && <span>{hint}</span>}</div>
          {list}
        </div>,
        document.body,
      )}
      <BottomSheet open={sheet} title={title} hint={hint} onClose={() => setSheet(false)}>{list}</BottomSheet>
    </div>
  );
}
