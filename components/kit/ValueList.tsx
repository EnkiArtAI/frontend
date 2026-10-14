"use client";

import { Copy } from "lucide-react";
import { valueText } from "@/lib/ui/kit/fields";
import "./kit-media.css";

export interface ValueRow {
  name: string;
  value: string;
  /** Set for a checkbox variable: its text shows behind a ticked or empty box. */
  checked?: boolean;
}

/** The values an image was made with, each with its own Copy: on the dark viewer ("stage") or on paper. */
export default function ValueList({ rows, onCopy, tone }: {
  rows: ValueRow[];
  onCopy?: (row: ValueRow) => void;
  tone: "stage" | "paper";
}) {
  return (
    <dl className="kit-values kit-focus" data-tone={tone}>
      {rows.map((row) => (
        <div key={row.name} className="kit-value">
          <dt className="kit-value-name">
            <span>{row.name}</span>
            {onCopy && (
              <button type="button" className="kit-copy kit-hit" aria-label={`Copy ${row.name}`} onClick={() => onCopy(row)}>
                <Copy size={11} strokeWidth={2.2} aria-hidden />Copy
              </button>
            )}
          </dt>
          <dd className="kit-value-text">{valueText(row)}</dd>
        </div>
      ))}
    </dl>
  );
}
