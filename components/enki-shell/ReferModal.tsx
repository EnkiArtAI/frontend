"use client";

/* Refer a prompt: the link to a post goes to the moderators, who rebuild it
   as a prompt. Kev, 2026-10-05: the dialog is the link and one button, the
   link is stored in the admin queue, and afterwards the dialog says in one
   short line that it arrived, with a check mark. */

import { useState, useEffect } from "react";
import { Icon } from "./icons";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { parseReferralLink, REFERRAL_PLATFORM_NAME } from "@/lib/referral-link";

const MONO = "var(--font-mono), monospace";
const SERIF = "var(--font-serif), Georgia, serif";
const NOT_SENT = "The link could not be sent in. Try again.";

interface ReferModalProps {
  onClose: () => void;
  /** Browsing without a login: the popup opens, the button stays grey. */
  guest?: boolean;
}

export default function ReferModal({ onClose, guest = false }: ReferModalProps) {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  // ESC cancels/closes the refer dialog.
  useEffect(() => {
    /* CAPTURE phase: the modal is the topmost surface, so its ESC must win.
       As a bubble listener it ran AFTER the sidebar's document-level ESC —
       the burger menu behind the scrim closed first while this dialog stayed
       (Kev, 2026-08-22). Window capture fires before any document listener,
       and stopPropagation keeps ESC from ever reaching the background. */
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Read as the server reads it, so the button is live only for a link it takes.
  const link = parseReferralLink(url);
  // A site the queue has no name for gets no chip.
  const platform = link && link.platform !== "other" ? REFERRAL_PLATFORM_NAME[link.platform] : null;
  const ready = Boolean(link) && !guest && state === "idle";

  const send = async () => {
    if (!link || !ready) return;
    setState("sending");
    setError(null);
    try {
      const res = await fetch("/api/referrals", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        credentials: "include",
        body: JSON.stringify({ url: link.url }),
      });
      if (res.ok) {
        setState("sent");
        return;
      }
      // The server's own sentence: already sent in, sign in, too many.
      const reason = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
      setError(typeof reason === "string" && reason ? reason : NOT_SENT);
    } catch {
      setError(NOT_SENT);
    }
    setState("idle");
  };

  return (
    <div className="ek-modal-scrim" onClick={onClose}>
      <div className="ek-modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="ek-modal-body" style={{ paddingTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
            <span style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(var(--ember-rgb), 0.12)", color: "var(--enki-ember)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Icon name="link" size={14} stroke={2} />
            </span>
            <span style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 19, fontWeight: 700, flex: 1, color: "var(--enki-ink)" }}>Refer a prompt</span>
            <button className="ek-modal-x" onClick={onClose} aria-label="Close"><Icon name="x" size={15} stroke={2} /></button>
          </div>

          {state === "sent" ? (
            <div role="status" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "10px 0 14px", textAlign: "center" }}>
              <span style={{ width: 46, height: 46, borderRadius: "50%", background: "#E8F8EE", color: "#1F8A5B", display: "flex", alignItems: "center", justifyContent: "center", animation: "ek-pop 0.3s ease-out" }}>
                <Icon name="check" size={24} stroke={2.6} />
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--enki-ink)" }}>Prompt sent in for checks.</span>
              <span style={{ fontSize: 12, color: "var(--enki-ink-3)" }}>We&apos;ll release it shortly.</span>
            </div>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, height: 34, border: "1px solid " + (url && !link ? "#e0584f" : "var(--enki-rule)"), borderRadius: 9, background: "var(--enki-paper)", padding: "0 10px" }}>
                <Icon name="link" size={13} stroke={2} style={{ color: "var(--enki-ink-3)", flexShrink: 0 }} />
                <input
                  type="url"
                  placeholder="https://x.com/…  ·  instagram.com/p/…"
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); setError(null); }}
                  autoFocus
                  aria-label="Link to the post"
                  style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", outline: "none", fontSize: 12, color: "var(--enki-ink)" }}
                />
                {platform && (
                  <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, color: "#1F5C38", background: "#E8F8EE", borderRadius: 4, padding: "2px 6px", flexShrink: 0 }}>{platform}</span>
                )}
              </div>
              {url && !link && <span style={{ display: "block", fontSize: 10, color: "#b33a3a", marginTop: 3 }}>Enter a full link starting with https://</span>}
              {error && <span role="alert" style={{ display: "block", fontSize: 10, color: "#b33a3a", fontWeight: 600, marginTop: 3 }}>{error}</span>}

              <button
                type="submit"
                title={guest ? "Sign in to refer a prompt" : undefined}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 7, width: "100%", minHeight: 34,
                  marginTop: 12, border: "none", borderRadius: 999, cursor: ready ? "pointer" : "default",
                  background: ready ? "var(--enki-ember)" : "color-mix(in oklab, var(--enki-ink-3) 55%, var(--enki-paper-2))",
                  color: "#fff", fontSize: 12, fontWeight: 600,
                }}
                disabled={!ready}
              >
                <Icon name="send" size={12} stroke={2} /> {state === "sending" ? "Sending…" : "Send in"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
