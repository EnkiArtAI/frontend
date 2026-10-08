"use client";

import { createPortal } from "react-dom";
import { Maximize2, ChevronDown } from "lucide-react";
import { usePanelPos, panelStyle } from "@/components/kit/panel-pos";
import "./ratio-select.css";

/**
 * Resolution picker in the ratio format — trigger and floating panel.
 *
 * The CLOSED control shows the setting alone ("2K"); the price appears only
 * on the OPEN panel's rows (Kev, 2026-08-24: "den preis NUR bei
 * aufgeklappten feldern"). A native <select> cannot do that split — its
 * closed face always mirrors the selected option's full text, which is how
 * "2K · $0.10" ended up truncated in a 230px rail.
 */
export interface ResolutionOption {
  tier: string;
  /** The server quote for this tier ("$0.147", "Free"); absent hides it. */
  priceLabel?: string;
}

export default function ResolutionSelect({ value, options, onChange, title, disabled = false }: {
  value: string;
  options: ResolutionOption[];
  onChange: (tier: string) => void;
  title?: string;
  disabled?: boolean;
}) {
  const { pos, open, toggle, close, trigRef, wrapRef, panelRef } = usePanelPos(options.length);

  return (
    <div ref={wrapRef} className="enki-ratio-sel">
      <button ref={trigRef} type="button" className={"enki-ratio-trig" + (open ? " open" : "")}
        disabled={disabled} title={title ?? "Resolution"} aria-label={title ?? "Resolution"}
        aria-expanded={open} onClick={toggle}>
        <Maximize2 size={12} aria-hidden />
        <span>{value}</span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {pos && createPortal(
        <div ref={panelRef} className="enki-ratio-panel" role="listbox" style={panelStyle(pos)}>
          {options.map((o) => (
            <button key={o.tier} type="button" role="option" aria-selected={o.tier === value}
              className={"enki-ratio-opt" + (o.tier === value ? " on" : "")}
              onClick={() => { onChange(o.tier); close(); }}>
              <span>{o.tier}</span>
              {o.priceLabel && <span className="enki-ratio-opt-sub">{o.priceLabel}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
