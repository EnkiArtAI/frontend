"use client";

import type { ReactNode } from "react";
import "./kit-controls.css";

/**
 * Two or three exclusive choices in one pill: Free | Premium, Text | Checkbox,
 * [ ] | T as a radiogroup; Craft | Verify and Generate | History | Comments as
 * a tablist.
 */
export default function Segmented<K extends string>({ options, value, onChange, ariaLabel, role }: {
  options: Array<{ key: K; label: ReactNode; title?: string }>;
  value: K;
  onChange: (key: K) => void;
  ariaLabel: string;
  role: "radiogroup" | "tablist";
}) {
  const radio = role === "radiogroup";
  return (
    <div className="kit-seg kit-focus" role={role} aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.key} type="button" className="kit-seg-btn" title={o.title}
          role={radio ? "radio" : "tab"}
          aria-checked={radio ? o.key === value : undefined}
          aria-selected={radio ? undefined : o.key === value}
          onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
