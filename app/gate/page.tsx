"use client";

import { useState } from "react";
import { gateNext } from "@/lib/gate-next";

// Decorative, non-interactive copy of the app's left menu — shown ONLY as an
// ultra-blurred backdrop so the gate reads as "the app, locked", without ever
// rendering real app content. The real protection is server-side (proxy.ts):
// removing this popup in devtools reveals nothing, because /home & co. are
// blocked at the edge and never sent to an unauthenticated visitor.
const MENU = [
  "Home",
  "Search",
  "Favorites",
  "Hall of Fame",
  "History",
  "Messages",
  "Color Setup",
  "Settings",
];

export default function GatePage() {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setLoading(true);
    setErr("");
    try {
      const r = await fetch("/api/gate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        /* Trimmed: a code pasted from a password manager or chat often
           carries a trailing space or newline, and the server compares
           exactly — "Wrong access code" for a correct code (Kev,
           2026-08-22). Whitespace is never part of the code. */
        body: JSON.stringify({ code: code.trim() }),
      });
      if (r.ok) {
        // Only a page of this site: ?next= is written by whoever made the link.
        window.location.href = gateNext(new URLSearchParams(window.location.search).get("next"));
        return;
      }
      const j = await r.json().catch(() => ({}));
      setErr(j?.error || "Wrong access code");
    } catch {
      setErr("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: "radial-gradient(120% 120% at 30% 0%, #0d2424 0%, #061616 55%, #030d0d 100%)",
        color: "#fff",
        fontFamily: "'DM Sans', system-ui, sans-serif",
      }}
    >
      {/* ── ultra-blurred left menu (decoration only, never interactive) ── */}
      <aside
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: 248,
          padding: "24px 18px",
          background: "rgba(8, 20, 20, 0.92)",
          borderRight: "1px solid rgba(255,255,255,0.06)",
          filter: "blur(7px)",
          opacity: 0.55,
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 30 }}>
          <img src="/favicon.svg" alt="" width={30} height={30} />
          <span style={{ fontWeight: 800, letterSpacing: "0.04em", fontSize: "1.05rem" }}>ENKI ART</span>
        </div>
        {MENU.map((label) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 10px" }}>
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: 6,
                background: "rgba(255,255,255,0.14)",
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: "0.92rem", color: "rgba(255,255,255,0.7)" }}>{label}</span>
          </div>
        ))}
      </aside>

      {/* soft frosted wash so the whole scene reads as blurred / out of reach */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backdropFilter: "blur(3px)",
          WebkitBackdropFilter: "blur(3px)",
          background: "rgba(3, 11, 11, 0.34)",
          pointerEvents: "none",
        }}
      />

      {/* ── the popup: centered over everything, nothing else in the middle ── */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <form
          onSubmit={submit}
          style={{
            width: "100%",
            maxWidth: 380,
            background: "rgba(10,22,22,0.86)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 18,
            padding: "34px 30px",
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
            textAlign: "center",
            boxShadow: "0 28px 70px rgba(0,0,0,0.55)",
          }}
        >
          <img src="/favicon.svg" alt="Enki Art" width={56} height={56} style={{ margin: "0 auto 16px", display: "block" }} />
          <h1 style={{ fontSize: "1.35rem", fontWeight: 800, margin: "0 0 6px", letterSpacing: "0.02em" }}>Private build</h1>
          <p style={{ fontSize: "0.88rem", color: "rgba(255,255,255,0.55)", margin: "0 0 22px", lineHeight: 1.55 }}>
            Enki Art is in private development. Enter the team access code to continue.
          </p>

          <input
            type="password"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Access code"
            autoFocus
            autoComplete="off"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "13px 16px",
              borderRadius: 11,
              border: err ? "1.5px solid #f87171" : "1.5px solid rgba(255,255,255,0.14)",
              background: "rgba(255,255,255,0.05)",
              color: "#fff",
              fontSize: "0.95rem",
              outline: "none",
            }}
          />

          {/* Always rendered with reserved height so the centered card never shifts when the error appears */}
          <div style={{ color: "#f87171", fontSize: "0.8rem", marginTop: 10, textAlign: "left", minHeight: "1.2em", visibility: err ? "visible" : "hidden" }}>{err || " "}</div>

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              marginTop: 18,
              padding: "13px 16px",
              borderRadius: 11,
              border: "none",
              cursor: loading ? "default" : "pointer",
              fontWeight: 700,
              fontSize: "0.95rem",
              color: "#1a0f00",
              background: "linear-gradient(135deg, #f6c98f, #e0936a)",
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? "Checking…" : "Enter"}
          </button>

          <a href="/" style={{ display: "inline-block", marginTop: 16, fontSize: "0.8rem", color: "rgba(255,255,255,0.5)", textDecoration: "none" }}>
            ← Back to landing page
          </a>
        </form>
      </div>
    </div>
  );
}
