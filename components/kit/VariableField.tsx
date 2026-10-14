"use client";

import { useId } from "react";
import { Copy } from "lucide-react";
import AutosizeTextarea from "./AutosizeTextarea";
import PillMenu from "./PillMenu";
import { choiceAsPills, fieldKind, multiValues, sliderRange, toggleMulti, type PromptVariable } from "@/lib/ui/kit/fields";
import "./kit-media.css";

/**
 * One buyer variable, asked the way its type asks: text (autosizing, 40 to
 * 120 px), a checkbox switch ("true" / "false"), one of a few choices as
 * pills or of many in a menu, several as toggle chips (comma-joined
 * promptValues), or a slider. The value is always the string the buyer page
 * keeps. Reference-image variables take no value and render nothing.
 */
export default function VariableField({ variable: v, value, onChange, growOnly, onUserInput, onCopy, maxLength }: {
  variable: PromptVariable;
  value: string;
  onChange: (value: string) => void;
  /** Values loaded from an image: the text field may grow but not shrink (useGrowOnly). */
  growOnly: boolean;
  onUserInput: () => void;
  onCopy?: () => void;
  /** A premium value goes to the server as typed, which takes 300 characters at most (VALUE_MAX). */
  maxLength?: number;
}) {
  const nameId = useId();
  const kind = fieldKind(v);
  if (!kind) return null;
  const label = v.label || v.name;
  const options = v.options ?? [];
  const chosen = multiValues(value);
  const slider = kind === "slider" ? sliderRange(v, value) : null;

  return (
    <div className="kit-field kit-focus" data-kind={kind}>
      <div className="kit-field-head">
        <span id={nameId} className="kit-field-name">{label}</span>
        {onCopy && (
          <button type="button" className="kit-field-copy kit-hit" aria-label={`Copy ${label}`} title="Copy" onClick={onCopy}>
            <Copy size={10} strokeWidth={2.2} aria-hidden />
          </button>
        )}
      </div>

      {kind === "text" && (
        <AutosizeTextarea className="kit-field-text" aria-labelledby={nameId} value={value} onChange={onChange}
          min={40} max={120} growOnly={growOnly} onUserInput={onUserInput} maxLength={maxLength}
          placeholder={v.description || `Enter ${label}…`} />
      )}

      {kind === "check" && (
        <label className="kit-field-check">
          <input type="checkbox" role="switch" checked={value === "true"}
            onChange={(e) => onChange(e.target.checked ? "true" : "false")} />
          <span className="kit-switch" aria-hidden />
          <span>{v.description || label}</span>
        </label>
      )}

      {kind === "choice" && (choiceAsPills(options.length) ? (
        <div className="kit-field-chips" role="radiogroup" aria-labelledby={nameId}>
          {options.map((o) => (
            <button key={o.promptValue} type="button" role="radio" aria-checked={o.promptValue === value}
              className="kit-chip kit-hit" onClick={() => onChange(o.promptValue)}>{o.visibleName}</button>
          ))}
        </div>
      ) : (
        <PillMenu ariaLabel={label} title={label} value={value || null} onPick={onChange}
          trigger={<span>{options.find((o) => o.promptValue === value)?.visibleName ?? "Choose…"}</span>}
          options={options.map((o) => ({ key: o.promptValue, label: o.visibleName }))} />
      ))}

      {kind === "multi" && (
        <div className="kit-field-chips" role="group" aria-labelledby={nameId}>
          {options.map((o) => (
            <button key={o.promptValue} type="button" aria-pressed={chosen.includes(o.promptValue)}
              className="kit-chip kit-hit" onClick={() => onChange(toggleMulti(value, o.promptValue, options))}>{o.visibleName}</button>
          ))}
        </div>
      )}

      {slider && (
        <div className="kit-field-slider">
          <input type="range" aria-labelledby={nameId} min={slider.min} max={slider.max} step={1} value={slider.value}
            onChange={(e) => onChange(e.target.value)} />
          <span className="kit-field-num">{slider.value}</span>
        </div>
      )}
    </div>
  );
}
