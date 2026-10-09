"use client";

import { useRef, useState } from "react";
import { X } from "lucide-react";
import AutosizeTextarea from "@/components/kit/AutosizeTextarea";
import Segmented from "@/components/kit/Segmented";
import type { VarKind } from "@/lib/editor/undo";

/**
 * One variable: its name (renaming rewrites every [token] of it), its value,
 * Text | Checkbox, and ×. A name the save could not keep apart from another
 * is refused while it is typed: the field keeps the text, says why, and goes
 * back to the last name that took when it loses focus (R19).
 */
export default function VariableRow({ name, value, kind, ai, issue, growOnly, onRename, onValue, onKind, onRemove, onUserInput }: {
  name: string;
  value: string;
  kind: VarKind;
  /** Vary wrote the value (✦ AI). */
  ai: boolean;
  /** Why the save could not store this name as it is, if it could not. */
  issue: string | null;
  growOnly: boolean;
  /** Applies the rename, or says why not. */
  onRename: (to: string) => string | null;
  onValue: (value: string) => void;
  onKind: (kind: VarKind) => void;
  onRemove: () => void;
  onUserInput: () => void;
}) {
  const [draft, setDraft] = useState<{ text: string; error: string } | null>(null);
  const valueRef = useRef<HTMLTextAreaElement>(null);
  const error = draft?.error ?? issue;
  return (
    <div className="pe-var" data-pe-name={name}>
      <div className="pe-var-line">
        <span className="pe-var-dot" aria-hidden />
        <input className="pe-var-name" data-pe-field="name" maxLength={60} placeholder="name this variable…"
          aria-label={name ? `Name of variable ${name}` : "Name of the new variable"} aria-invalid={!!error || undefined}
          data-state={draft || issue ? "error" : !name ? "unnamed" : undefined}
          value={draft?.text ?? name}
          onChange={(e) => {
            const text = e.target.value.replace(/[[\]\n]/g, "");
            const why = onRename(text);
            setDraft(why ? { text, error: why } : null);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            valueRef.current?.focus();
          }}
          onBlur={() => setDraft(null)} />
        {ai && <span className="pe-ai" title="The AI wrote this value — edit it or undo">✦ AI</span>}
        <Segmented role="radiogroup" ariaLabel="Kind" value={kind} onChange={onKind} options={[
          { key: "text", label: "Text", title: "Text: people type a value" },
          { key: "checkbox", label: <><span className="pe-box" aria-hidden />Checkbox</>, title: "Checkbox: people tick it on or off" },
        ]} />
        <button type="button" className="pe-var-x kit-hit" title="Remove variable" aria-label="Remove variable" onClick={onRemove}>
          <X size={14} strokeWidth={2.2} aria-hidden />
        </button>
      </div>
      {error && <p className="pe-var-issue">{error}</p>}
      <AutosizeTextarea ref={valueRef} className="pe-var-value" data-pe-field="value" maxLength={300}
        aria-label={name ? `Value of ${name}` : "Value of the new variable"}
        placeholder={kind === "checkbox" ? "Text added to the prompt when ticked" : `Example ${name || "value"}`}
        value={value} onChange={onValue} min={40} max={120} growOnly={growOnly} onUserInput={onUserInput} />
    </div>
  );
}
