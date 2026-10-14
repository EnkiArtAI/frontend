"use client";

import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

export type EditorTab = "craft" | "verify";

/** A pane's id, and below 1024 px its role as a tab's panel. */
export type PaneProps = { id: string; role?: "tabpanel"; "aria-labelledby"?: string };

const STEPS = ["Craft", "Verify", "Release"] as const;
const TABS: readonly EditorTab[] = ["craft", "verify"];

/**
 * Back, the title and the three steps. From 1024 px the steps only show
 * progress; below, Craft and Verify are tabs, and Release, which lives at the
 * end of Verify, stays a step. The title is not in undo: Cmd+Z there is the
 * field's own.
 */
export default function EditorHeader({ title, onTitle, done, active, tab, onTab, tabs, panes, rendering, onBack, notice }: {
  title: string;
  onTitle: (title: string) => void;
  /** Craft has a prompt, Verify a finished render, Release went through. */
  done: readonly boolean[];
  /** The step reached, for the progress look. */
  active: number;
  tab: EditorTab;
  onTab: (tab: EditorTab) => void;
  /** Below 1024 px (TABS): Craft and Verify are tabs. */
  tabs: boolean;
  /** The ids of the panes the tabs control. */
  panes: Record<EditorTab, string>;
  /** Renders still running: the Verify tab counts them. */
  rendering: number;
  onBack: () => void;
  notice?: ReactNode;
}) {
  const flags = (i: number) => ({ "data-active": i === active || undefined, "data-done": done[i] || undefined });
  const face = (i: number) => (
    <>
      <span className="pe-step-badge" aria-hidden>{done[i] && i !== active ? "✓" : i + 1}</span>
      {STEPS[i]}
      {i === 1 && rendering > 0 && <span className="pe-step-n"> · {rendering}</span>}
    </>
  );
  const shown = (i: number) => (
    <span key={i} className="pe-step" {...flags(i)} aria-current={i === active ? "step" : undefined}>{face(i)}</span>
  );
  return (
    <header className="pe-head">
      {/* Back and the title take the Craft column's width from 1024 px, so the steps start where the Verify column does (Kev, 2026-10-13). */}
      <div className="pe-head-left">
        <button type="button" className="pe-back kit-hit" aria-label="Back" onClick={onBack}>
          <ChevronLeft size={13} strokeWidth={2.4} aria-hidden />
          <span className="pe-back-label">Back</span>
        </button>
        <input className="pe-title" data-pe-field="title" data-native-undo value={title} placeholder="Untitled prompt"
          aria-label="Prompt title" onChange={(e) => onTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
      </div>
      <div className="pe-steps">
        {tabs ? (
          <div className="pe-tablist" role="tablist" aria-label="Steps">
            {TABS.map((t, i) => (
              <button key={t} type="button" role="tab" id={`${panes[t]}-tab`} className="pe-step kit-hit" {...flags(i)}
                aria-selected={tab === t} aria-controls={panes[t]} onClick={() => onTab(t)}>
                {face(i)}
              </button>
            ))}
          </div>
        ) : (
          <div className="pe-tablist">{TABS.map((_, i) => shown(i))}</div>
        )}
        {shown(2)}
      </div>
      {notice}
    </header>
  );
}
