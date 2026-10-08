"use client";

import { createPortal } from "react-dom";
import { Gem, ChevronDown } from "lucide-react";
import { usePanelPos, panelStyle } from "@/components/kit/panel-pos";
// Same classes as RatioSelect on purpose: the quality field sits directly
// under ratio + resolution and read as a foreign control with its own bare
// styling (Kev, 2026-08-24: "i want the format of e.g. ratio").
import "./ratio-select.css";

/**
 * Quality — low | mid | high, for models that take it as their own parameter.
 *
 * Only the gpt-image family does, on both hosts. It is a real setting there,
 * and the dominant one for price: roughly $0.006 / $0.053 / $0.211 per image at
 * 1024x1024, a 35x spread — far more than the size changes. So it belongs in
 * front of the user rather than being derived from the resolution tier, which
 * is what the server did before and was a guess about intent.
 *
 * Hidden entirely for models without it. Gemini has no such concept, and a
 * control that changes nothing is exactly the kind of thing this codebase has
 * been busy removing.
 */

export type Quality = "low" | "medium" | "high";

/* No price claims here: the price shown beside Generate is the server's
   quote for the chosen quality, which also carries the artist share and the
   fee, so a ratio of model costs ("9x") was not what anyone paid. */
const HINT: Record<Quality, string> = {
  low: "Fastest and cheapest. Fine for trying an idea out.",
  medium: "The middle ground in detail and price.",
  high: "Best detail and the highest price; use it on keepers.",
};

const LABEL: Record<Quality, string> = { low: "Low", medium: "Mid", high: "High" };
const ORDER: Quality[] = ["low", "medium", "high"];

export interface QualitySelectProps {
  value: Quality;
  onChange: (next: Quality) => void;
  /** Hidden when the chosen model has no quality parameter. */
  available?: boolean;
  disabled?: boolean;
  className?: string;
}

export default function QualitySelect({
  value,
  onChange,
  available = true,
  disabled = false,
  className = "",
}: QualitySelectProps) {
  const { pos, open, toggle, close, trigRef, wrapRef, panelRef } = usePanelPos(ORDER.length);

  if (!available) return null;

  return (
    <div ref={wrapRef} className={`enki-ratio-sel ${className}`.trim()}>
      <button ref={trigRef} type="button" className={"enki-ratio-trig" + (open ? " open" : "")}
        disabled={disabled} title={`Quality — ${HINT[value]}`} aria-label="Image quality"
        aria-expanded={open} onClick={toggle}>
        <Gem size={13} strokeWidth={2.2} aria-hidden />
        <span>{LABEL[value]}</span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {pos && createPortal(
        <div ref={panelRef} className="enki-ratio-panel" role="listbox" style={panelStyle(pos)}>
          {ORDER.map((q) => (
            <button key={q} type="button" role="option" aria-selected={q === value}
              className={"enki-ratio-opt" + (q === value ? " on" : "")}
              title={HINT[q]}
              onClick={() => { onChange(q); close(); }}>
              <Gem size={13} strokeWidth={2.2} aria-hidden />
              <span>{LABEL[q]}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
