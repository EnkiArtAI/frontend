"use client";

/* Feedback ($100 program) — the "Earn money" sibling of Refer a prompt.
   Severity + description + optional image/video attachments; lands in
   feedback_submissions via POST /api/feedback and shows up in the admin
   panel's Feedback queue. $100 is paid when the change ships. */

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { FEEDBACK_FILE_EXT, FEEDBACK_MAX_BYTES, addFeedbackFiles, type FeedbackDecision } from "@/lib/feedback";
import { fitUpload } from "@/lib/shrink-image";

const SEVS = [
  { id: "bug", label: "Bug — broken", bg: "#FDE8E8", ink: "#8B2E2E", border: "#E8A0A0" },
  { id: "issue", label: "Real issue", bg: "rgba(201,104,56,0.1)", ink: "var(--enki-ember, #c96838)", border: "rgba(201,104,56,0.45)" },
  { id: "annoying", label: "Annoying", bg: "#FDF6E8", ink: "#6E4A1E", border: "#E8C89A" },
  { id: "minor", label: "Somewhat annoying", bg: "var(--enki-paper-2)", ink: "var(--enki-ink-3)", border: "var(--enki-rule)" },
];

/** One of the sender's own reports, as GET /api/feedback answers it. */
type Mine = { id: string; at: string; preview: string; state: FeedbackDecision; paid: boolean; payoutCents: number; txUrl: string | null };
const STATE_LABEL: Record<FeedbackDecision, string> = { open: "In review", done: "Done", rejected: "Declined" };

/** Still images are drawn anew before they count; a GIF would lose its motion and a video cannot be. */
const STILLS = ["image/png", "image/jpeg", "image/webp"];

const MONO = "var(--font-mono), monospace";
const SERIF = "var(--font-serif), Georgia, serif";
const microLabel: React.CSSProperties = {
  display: "block", fontFamily: MONO, fontSize: 8, letterSpacing: "0.13em",
  textTransform: "uppercase", color: "var(--enki-ink-3)",
};

export default function FeedbackModal({ onClose, onToast, guest = false }: { onClose: () => void; onToast: (msg: string) => void; guest?: boolean }) {
  const [sev, setSev] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  // While picked images are redrawn the list holds still, so nothing is added to a stale one.
  const [attaching, setAttaching] = useState(false);
  const [done, setDone] = useState(false);
  const [mine, setMine] = useState<Mine[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const doneT = useRef<number | null>(null);

  // ESC closes the dialog (Kev: close the UI on ESC, always).
  useEffect(() => {
    /* CAPTURE phase: the modal is the topmost surface, so its ESC must win.
       As a bubble listener it ran AFTER the sidebar's document-level ESC —
       the burger menu behind the scrim closed first while this dialog stayed
       (Kev, 2026-08-22). Window capture fires before any document listener,
       and stopPropagation keeps ESC from ever reaching the background. */
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); if (doneT.current) window.clearTimeout(doneT.current); };
  }, [onClose]);

  // The sender's own reports and what became of each (Kev, 2026-10-08).
  useEffect(() => {
    if (guest) return;
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/feedback", { headers: sessionAuthHeaders() });
        const d = res.ok ? ((await res.json()) as { items: Mine[] }) : null;
        if (d && !dead) setMine(d.items);
      } catch { /* the list is extra; the form works without it */ }
    })();
    return () => { dead = true; };
  }, [guest]);

  const canSend = !!sev && text.trim().length >= 10 && !busy && !attaching; // server wants ≥10 chars

  // The route's own rules (lib/feedback): a file it would refuse is named now, not after sending.
  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setAttaching(true);
    try {
      // Every upload is made smaller in the browser (Kev, 2026-10-08): a screenshot
      // then takes a few hundred KB of the 4 MB. One that cannot be redrawn goes as it is.
      const picked = await Promise.all(Array.from(list).map(async (f) => (STILLS.includes(f.type) ? ((await fitUpload(f)) ?? f) : f)));
      const { files: next, refused } = addFeedbackFiles(files, picked);
      setFiles(next);
      // One toast for the lot: each would replace the one before.
      if (refused.length) onToast(refused.join(" "));
    } finally {
      setAttaching(false);
    }
  };

  const send = async () => {
    if (!canSend || !sev) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("severity", sev);
      fd.append("description", text.trim());
      files.forEach((f) => fd.append("files", f));
      const res = await fetch("/api/feedback", { method: "POST", headers: sessionAuthHeaders(), body: fd });
      const data = await res.json().catch(() => ({} as { error?: string; dropped?: number }));
      if (!res.ok) { onToast(data.error || "Could not send your feedback."); return; }
      if (data.dropped) {
        onToast(`Feedback sent, but ${data.dropped === 1 ? "1 attachment was" : `${data.dropped} attachments were`} not kept: only still images that pass our check, and MP4, WebM or MOV videos, are.`);
      }
      setDone(true);
      doneT.current = window.setTimeout(onClose, 2200);
    } catch {
      onToast("Network hiccup — your feedback wasn't sent.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ek-modal-scrim" onClick={onClose}>
      <div className="ek-modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        {done ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "34px 20px" }}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#1f8a5b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 8 }}>
              <path d="M21.801 10A10 10 0 1 1 17 3.335" /><path d="m9 11 3 3L22 4" />
            </svg>
            <span style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 700, marginBottom: 3, color: "var(--enki-ink)" }}>Feedback in!</span>
            <span style={{ fontSize: 12, color: "var(--enki-ink-3)", lineHeight: 1.5 }}>
              Thanks.<br />If we build your change, <b style={{ color: "var(--enki-ember, #c96838)" }}>$100</b> lands in your wallet.
            </span>
          </div>
        ) : (
          <div className="ek-modal-body" style={{ paddingTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
              <span style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(var(--ember-rgb), 0.12)", color: "var(--enki-ember)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon name="message" size={14} stroke={2} />
              </span>
              <span style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 19, fontWeight: 700, flex: 1, color: "var(--enki-ink)" }}>Feedback</span>
              <button className="ek-modal-x" onClick={onClose} aria-label="Close"><Icon name="x" size={15} stroke={2} /></button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, border: "1px dashed rgba(var(--ember-rgb), 0.5)", background: "rgba(var(--ember-rgb), 0.07)", borderRadius: 11, padding: "10px 13px", marginBottom: 12 }}>
              <span style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 700, color: "var(--enki-ember)", lineHeight: 1, flexShrink: 0 }}>$100</span>
              <span style={{ fontSize: 11.5, color: "var(--enki-ink-2)", lineHeight: 1.5 }}>
                <b>Get $100 if your feedback gets fixed or implemented.</b><br />Spot something broken or clunky? Tell us.
              </span>
            </div>

            <span style={{ ...microLabel, marginBottom: 5 }}>How bad is it?</span>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 12 }}>
              {SEVS.map((s) => {
                const on = sev === s.id;
                return (
                  <button key={s.id} onClick={() => setSev(s.id)} style={{
                    padding: "4px 11px", borderRadius: 999, fontSize: 10.5, whiteSpace: "nowrap", cursor: "pointer",
                    fontWeight: on ? 700 : 500,
                    border: "1px solid " + (on ? s.border : "var(--enki-rule)"),
                    background: on ? s.bg : "var(--enki-paper)",
                    color: on ? s.ink : "var(--enki-ink-3)",
                  }}>
                    {s.label}
                  </button>
                );
              })}
            </div>

            <span style={{ ...microLabel, marginBottom: 4 }}>What should change?</span>
            <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="Describe the bug or the change you want — the clearer it is, the easier it is to build (and pay you)."
              style={{ display: "block", width: "100%", border: "1px solid var(--enki-rule)", borderRadius: 9, background: "var(--enki-paper)", padding: "8px 10px", fontSize: 12, lineHeight: 1.55, color: "var(--enki-ink)", outline: "none", resize: "vertical" }} />

            <span style={{ ...microLabel, margin: "11px 0 5px" }}>Attachments · up to {FEEDBACK_MAX_BYTES / 1048576} MB in total</span>
            <input ref={fileRef} type="file" accept={Object.keys(FEEDBACK_FILE_EXT).join(",")} multiple style={{ display: "none" }}
              onChange={(e) => { void addFiles(e.target.files); e.currentTarget.value = ""; }} />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
              <button onClick={() => fileRef.current?.click()} disabled={attaching} title={attaching ? "Preparing images…" : "Attach images or videos"} style={{ width: 52, height: 40, border: "1px dashed var(--enki-rule)", borderRadius: 9, background: "var(--enki-paper)", color: "var(--enki-ink-3)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                <Icon name="upload" size={15} stroke={2} />
              </button>
              {files.map((f, i) => (
                <span key={`${f.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 7, height: 40, border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 9, background: "var(--enki-paper)", padding: "0 9px", maxWidth: 170 }}>
                  <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</span>
                    <span style={{ fontFamily: MONO, fontSize: 8, color: "var(--enki-ink-3)" }}>
                      {(f.type || "").startsWith("video") ? "Video" : "Image"} · {(f.size / 1048576).toFixed(1)} MB
                    </span>
                  </span>
                  <button onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} disabled={attaching} aria-label="Remove attachment"
                    style={{ width: 16, height: 16, border: "none", borderRadius: "50%", background: "var(--enki-paper-2)", color: "var(--enki-ink-3)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, padding: 0, cursor: "pointer" }}>
                    <Icon name="x" size={9} stroke={2.4} />
                  </button>
                </span>
              ))}
            </div>

            <button className="ek-btn" style={{ minHeight: 40, opacity: canSend && !guest ? 1 : 0.55 }} disabled={!canSend || guest} title={guest ? "Sign in to submit" : undefined} onClick={() => void send()}>
              {busy ? "Sending…" : "Send feedback"}
            </button>

            {mine.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <span style={{ ...microLabel, marginBottom: 4 }}>Your feedback</span>
                <div style={{ maxHeight: 150, overflowY: "auto" }}>
                  {mine.map((m) => (
                    <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px dashed var(--enki-rule)" }}>
                      <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--enki-ink-3)", flexShrink: 0 }}>{new Date(m.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--enki-ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.preview}</span>
                      {m.paid && m.txUrl
                        ? <a href={m.txUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, fontWeight: 700, color: "#1f8a5b", flexShrink: 0 }}>Paid ${m.payoutCents / 100} ↗</a>
                        : <span style={{ fontSize: 10, color: "var(--enki-ink-3)", flexShrink: 0 }}>{m.paid ? "Paid" : STATE_LABEL[m.state]}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
