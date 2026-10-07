"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { workflowVars } from "@/lib/editor/workflow-tokens";
import { Icon } from "./icons";

/**
 * Pick a prompt or workflow to embed as a WORKFLOW NODE (Kev, 2026-09-05).
 * Two shelves: the owner's private library (full graphs, full text) and the
 * marketplace's free prompts (their public text). Paid prompts are not
 * offered yet — embedding them needs the fair-share rail (each embedded
 * author paid per generation), which is the next step.
 */
export interface WorkflowPick {
  promptId: string | null;
  title: string;
  author?: string;
  text: string;
  vars: string[];
}

type LibraryRow = { id: string; name: string; kind: string; prompt_text: string | null; graph: { prompt?: string } | null };
type MarketRow = { id: string; title: string; promptTemplate?: string; description?: string; creator?: { displayName?: string; handle?: string } | null };

export default function WorkflowPicker({ onPick, onClose }: { onPick: (w: WorkflowPick) => void; onClose: () => void }) {
  const [tab, setTab] = useState<"library" | "market">("library");
  const [lib, setLib] = useState<LibraryRow[] | null>(null);
  const [libErr, setLibErr] = useState<string | null>(null);
  const [market, setMarket] = useState<MarketRow[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch("/api/library", { headers: sessionAuthHeaders() })
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as { items?: LibraryRow[]; error?: string };
        if (!r.ok) { setLibErr(d.error || `Couldn't load your library (HTTP ${r.status}).`); setLib([]); return; }
        setLib(Array.isArray(d.items) ? d.items : []);
      })
      .catch(() => { setLibErr("Couldn't load your library."); setLib([]); });
    fetch("/api/marketplace/prompts?limit=40&sortBy=newest&priceFilter=free", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { prompts: [] }))
      .then((d) => setMarket(Array.isArray(d.prompts) ? d.prompts : []))
      .catch(() => setMarket([]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const needle = q.trim().toLowerCase();
  const libRows = (lib ?? []).filter((r) => !needle || r.name.toLowerCase().includes(needle));
  const marketRows = (market ?? []).filter((r) => !needle || r.title.toLowerCase().includes(needle));

  return createPortal(
    <div className="ek-modal-scrim" style={{ zIndex: 1500 }} onClick={onClose}>
      <div className="ek-modal nc-wfpick" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Insert a prompt or workflow">
        <div className="nc-wfpick-head">
          <span className="nc-wfpick-title">Insert a prompt or workflow</span>
          <button type="button" className="nc-ntrash" onClick={onClose} aria-label="Close"><Icon name="x" size={16} stroke={2} /></button>
        </div>
        <div className="nc-wfpick-tabs">
          <button type="button" className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>My library</button>
          <button type="button" className={tab === "market" ? "on" : ""} onClick={() => setTab("market")}>Free prompts</button>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search" />
        </div>
        <div className="nc-wfpick-list">
          {tab === "library" ? (
            lib === null ? <div className="nc-wfpick-empty">Loading…</div>
            : libErr ? <div className="nc-wfpick-empty">{libErr}</div>
            : libRows.length === 0 ? <div className="nc-wfpick-empty">Nothing saved yet — use “Save to library” in the editor menu.</div>
            : libRows.map((r) => {
              const text = r.prompt_text ?? r.graph?.prompt ?? "";
              return (
                <button key={r.id} type="button" className="nc-wfpick-row"
                  onClick={() => onPick({ promptId: null, title: r.name, text, vars: workflowVars(text) })}>
                  <span className="nc-wfpick-name">{r.name}</span>
                  <span className="nc-wfpick-meta">{r.kind} · {workflowVars(text).length} input{workflowVars(text).length === 1 ? "" : "s"}</span>
                  <span className="nc-wfpick-text">{text.slice(0, 140)}</span>
                </button>
              );
            })
          ) : (
            market === null ? <div className="nc-wfpick-empty">Loading…</div>
            : marketRows.length === 0 ? <div className="nc-wfpick-empty">No free prompts found.</div>
            : marketRows.map((r) => {
              const text = r.promptTemplate || r.description || "";
              const author = r.creator?.displayName || r.creator?.handle || undefined;
              return (
                <button key={r.id} type="button" className="nc-wfpick-row"
                  onClick={() => onPick({ promptId: r.id, title: r.title, author, text, vars: workflowVars(text) })}>
                  <span className="nc-wfpick-name">{r.title}</span>
                  <span className="nc-wfpick-meta">{author ? `by ${author} · ` : ""}free · {workflowVars(text).length} input{workflowVars(text).length === 1 ? "" : "s"}</span>
                  <span className="nc-wfpick-text">{text.slice(0, 140)}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
