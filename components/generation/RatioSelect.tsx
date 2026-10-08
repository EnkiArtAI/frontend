"use client";

import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import RatioRect from "./RatioRect";
import { usePanelPos, panelStyle } from "@/components/kit/panel-pos";
// Self-carried styles, the BoostToggle pattern: surfaces outside the editor
// (buyer generator, quick create) do not load nodes.css.
import "./ratio-select.css";

/**
 * The one aspect-ratio picker for surfaces that used a native <select>.
 *
 * A native option cannot render the ratio's shape, and Kev wants the little
 * rectangle beside every ratio everywhere ("globally ... mit den fitting
 * rechtecken", 2026-08-22). The editor's NcSelect draws the same rects; this
 * component brings them to the plain-CSS surfaces without dragging the whole
 * editor module along.
 */
export default function RatioSelect({ value, options, onChange, title }: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  title?: string;
}) {
  const { pos, open, toggle, close, trigRef, wrapRef, panelRef } = usePanelPos(options.length);

  return (
    <div ref={wrapRef} className="enki-ratio-sel">
      <button ref={trigRef} type="button" className={"enki-ratio-trig" + (open ? " open" : "")}
        title={title} aria-label={title ?? "Aspect ratio"} aria-expanded={open} onClick={toggle}>
        <RatioRect ratio={value} size={14} />
        <span>{value}</span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {pos && createPortal(
        <div ref={panelRef} className="enki-ratio-panel" role="listbox" style={panelStyle(pos)}>
          {options.map((r) => (
            <button key={r} type="button" role="option" aria-selected={r === value}
              className={"enki-ratio-opt" + (r === value ? " on" : "")}
              onClick={() => { onChange(r); close(); }}>
              <RatioRect ratio={r} size={15} />
              <span>{r}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
