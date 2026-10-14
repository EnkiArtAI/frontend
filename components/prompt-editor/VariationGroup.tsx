"use client";

import type { CSSProperties } from "react";
import type { Variation } from "@/lib/editor/variations";
import ResultTile, { type TileActs } from "./ResultTile";
import StackCard from "./StackCard";

/** A stack's key in the set of open ones: unique across variations. */
export const stackKey = (group: Variation, stack: { key: string }) => `${group.key}|${stack.key}`;

/**
 * One variation (handoff §4): the same text, so the same variables. Its chip
 * keeps the letter and colour it got when it first appeared; its renders sit
 * in stacks by values, newest first.
 */
export default function VariationGroup({ group, open, onToggle, onLoad, acts }: {
  group: Variation;
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onLoad: () => void;
  acts: TileActs;
}) {
  const summary = group.names.length ? `Variables: ${group.names.map((n) => `[${n}]`).join(" ")}` : group.jobs[0].setup.prompt;
  return (
    <section className="pe-group" data-pe-group={group.key} style={{ "--pe-vc": group.color } as CSSProperties}
      aria-label={`Variation ${group.letter}`}>
      <div className="pe-group-head">
        <span className="pe-chip">Variation {group.letter} · {group.jobs.length}</span>
        <span className="pe-summary">{summary}</span>
        <button type="button" className="pe-load kit-hit" title="Put this prompt back in the editor" onClick={onLoad}>← Load prompt</button>
      </div>
      <div className="pe-grid">
        {group.stacks.map((st) => {
          const key = stackKey(group, st);
          return st.jobs.length === 1
            ? <ResultTile key={key} job={st.jobs[0]} acts={acts} />
            : <StackCard key={key} jobs={st.jobs} open={open.has(key)} onToggle={() => onToggle(key)} acts={acts} />;
        })}
      </div>
    </section>
  );
}
