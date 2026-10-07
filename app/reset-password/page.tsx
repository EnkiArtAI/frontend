"use client";

/**
 * /reset-password — get back into your account, two ways (Kev's design):
 *
 *  EMAIL    → enter email → we mail a 7-digit code → enter code + new
 *             password (repeated, match-checked) → logged in.
 *  GUARDIAN → enter email → every confirmed email-guardian gets a code +
 *             link; this page waits and polls → at the approval threshold
 *             you set the new password → logged in.
 *
 * The guardian request survives reloads via localStorage (requestId+ownerKey).
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, KeyRound, Mail, Users } from "lucide-react";
import EnkiCardPage, { EnkiCardButton, EnkiCardInput } from "@/components/EnkiCardPage";

const SUB = { fontSize: 14, lineHeight: 1.6, color: "rgba(245,242,236,0.72)" } as const;
const ERR = { fontSize: 13, color: "#ff7a6b", margin: "10px 0 0" } as const;
const RECOVERY_LS = "enki-recovery-request";

/** Store the fresh session exactly like the login flow does. */
function adoptSession(data: { token?: string; email?: string }) {
  if (!data.token) return;
  try {
    localStorage.setItem("enki_session_token", data.token);
    if (data.email) localStorage.setItem("enki_session_email", data.email);
    window.dispatchEvent(new Event("enki-email-auth-changed"));
  } catch { /* storage unavailable */ }
}

function ResetPasswordInner() {
  const router = useRouter();
  // embed=1 → rendered inside the landing login popup (iframe): card chrome
  // off, and "done" navigates the TOP window.
  const embed = useSearchParams().get("embed") === "1";
  const [mode, setMode] = useState<"choice" | "email" | "guardian">("choice");

  // shared fields
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // email flow
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");

  // guardian flow
  const [request, setRequest] = useState<{ id: string; key: string } | null>(null);
  const [progress, setProgress] = useState<{ approved: number; threshold: number } | null>(null);
  const [approved, setApproved] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Resume a guardian request after a reload.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECOVERY_LS);
      if (raw) {
        const saved = JSON.parse(raw) as { id: string; key: string };
        setRequest(saved);
        setMode("guardian");
      }
    } catch { /* ignore */ }
  }, []);

  // Poll the guardian request until approved/expired.
  useEffect(() => {
    if (!request || approved) return;
    const poll = async () => {
      try {
        const res = await fetch(`/api/recovery/request?id=${request.id}&key=${encodeURIComponent(request.key)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { status: string; approved: number; threshold: number };
        setProgress({ approved: data.approved, threshold: data.threshold });
        if (data.status === "approved") setApproved(true);
        if (data.status === "expired" || data.status === "completed") {
          localStorage.removeItem(RECOVERY_LS);
          if (data.status === "expired") { setRequest(null); setError("The request expired — start again."); }
        }
      } catch { /* transient */ }
    };
    poll();
    pollRef.current = setInterval(poll, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [request, approved]);

  const pwProblem = pw && pw2 && pw !== pw2 ? "The two passwords don't match." : pw && pw.length < 8 ? "At least 8 characters." : null;

  // Embedded: the popup is ALWAYS dark (#0E0E12, in every color scheme — see
  // landing.html .auth-modal), so the embed paints itself opaque in exactly
  // that color (EnkiCardPage embed mode). Pin html/body to it too so no page
  // margin or late ThemeProvider repaint can flash a different color through.
  useEffect(() => {
    if (!embed) return;
    document.documentElement.style.background = "#0E0E12";
    document.body.style.background = "#0E0E12";
  }, [embed]);

  // Inside the login-popup iframe the WHOLE page must navigate, not the frame.
  const goHome = (path = "/home") => {
    if (embed && window.top && window.top !== window) window.top.location.href = path;
    else router.replace(path);
  };

  // Embedded choice screen: ← returns to the login form (parent listens).
  const backToLogin = embed
    ? () => window.parent?.postMessage({ type: "enki-reset-back" }, "*")
    : undefined;

  // ESC leaves the reset flow and returns to the login screen (embedded: the
  // popup's login form; standalone: the landing page, which hosts the login).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || done) return;
      if (embed) window.parent?.postMessage({ type: "enki-reset-back" }, "*");
      else router.push("/");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embed, done, router]);

  // ← back to the choice screen (clears sub-state; an active guardian request
  // survives in localStorage and resumes when re-entering the guardian path).
  const backToChoice = () => {
    setMode("choice");
    setError(null);
    setCodeSent(false);
    setCode(""); setPw(""); setPw2("");
  };

  const sendCode = async () => {
    setBusy(true); setError(null);
    try {
      await fetch("/api/auth/password/forgot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      setCodeSent(true); // always — the API never reveals whether the email exists
    } finally { setBusy(false); }
  };

  const resetWithCode = async () => {
    if (pwProblem || code.length !== 7) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/auth/password/reset-code", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code, password: pw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not reset");
      adoptSession(data);
      setDone(true);
      // An inbox reset enters like a login: a banned account goes to /banned.
      setTimeout(() => goHome(data.banned ? "/banned" : "/home"), 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reset");
    } finally { setBusy(false); }
  };

  const startGuardian = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/recovery/request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not start recovery");
      const saved = { id: data.requestId as string, key: data.ownerKey as string };
      localStorage.setItem(RECOVERY_LS, JSON.stringify(saved));
      setRequest(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start recovery");
    } finally { setBusy(false); }
  };

  const completeGuardian = async () => {
    if (pwProblem || !request) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/recovery/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: request.id, ownerKey: request.key, password: pw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not finish");
      localStorage.removeItem(RECOVERY_LS);
      adoptSession(data);
      setDone(true);
      setTimeout(goHome, 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not finish");
    } finally { setBusy(false); }
  };

  const passwordFields = (
    <>
      <EnkiCardInput type="password" placeholder="New password (min. 8 characters)" autoComplete="new-password"
        value={pw} onChange={(e) => setPw(e.target.value)} />
      <EnkiCardInput type="password" placeholder="Repeat new password" autoComplete="new-password"
        value={pw2} onChange={(e) => setPw2(e.target.value)} />
      {pwProblem && <p style={{ ...ERR, margin: 0 }}>{pwProblem}</p>}
    </>
  );

  if (done) {
    return (
      <EnkiCardPage embed={embed} title="You're back in." eyebrow="Enki Art · Account">
        <p style={{ ...SUB, display: "flex", alignItems: "center", gap: 8 }}>
          <CheckCircle2 size={18} style={{ color: "#7fd99a" }} /> Your password is updated. Taking you in…
        </p>
      </EnkiCardPage>
    );
  }

  // ── Choice screen ──────────────────────────────────────────────────────────
  if (mode === "choice") {
    return (
      <EnkiCardPage embed={embed} onBack={backToLogin} title="Get back into your account." eyebrow="Enki Art · Account">
        <p style={{ ...SUB, marginBottom: 22 }}>Pick the way that works for you right now.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {([
            { m: "email" as const, icon: <Mail size={18} />, t: "Via email", s: "We send a 7-digit code to your account email." },
            { m: "guardian" as const, icon: <Users size={18} />, t: "Via guardians", s: "Your trusted guardians approve. Works even when your email is gone too." },
          ]).map((o) => (
            <button key={o.m} onClick={() => { setMode(o.m); setError(null); }}
              style={{
                display: "flex", alignItems: "center", gap: 14, textAlign: "left", cursor: "pointer",
                padding: "16px 16px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.04)", color: "#f5f2ec",
              }}>
              <span style={{ color: "#e8a83a" }}>{o.icon}</span>
              <span>
                <span style={{ display: "block", fontSize: 14, fontWeight: 700 }}>{o.t}</span>
                <span style={{ display: "block", fontSize: 12.5, color: "rgba(245,242,236,0.6)" }}>{o.s}</span>
              </span>
            </button>
          ))}
        </div>
      </EnkiCardPage>
    );
  }

  // ── Email flow ─────────────────────────────────────────────────────────────
  if (mode === "email") {
    return (
      <EnkiCardPage embed={embed} onBack={backToChoice} title={codeSent ? "Check your inbox." : "Reset via email."} eyebrow="Enki Art · Account">
        {!codeSent ? (
          <form onSubmit={(e) => { e.preventDefault(); sendCode(); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={SUB}>
              Enter your account email.<br />
              We&apos;ll send you a 7-digit code.
            </p>
            <EnkiCardInput type="email" required autoFocus placeholder="you@example.com"
              value={email} onChange={(e) => setEmail(e.target.value)} />
            <EnkiCardButton type="submit" disabled={busy || !email.includes("@")}>
              {busy ? "Sending…" : "Send code"}
            </EnkiCardButton>
          </form>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); resetWithCode(); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={SUB}>
              If an account exists for <b>{email}</b>, the code is on its way.<br />
              It stays valid for 15 minutes.
            </p>
            <EnkiCardInput
              inputMode="numeric" autoComplete="one-time-code" placeholder="1234567" maxLength={7} autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 7))}
              style={{ textAlign: "center", fontSize: 26, letterSpacing: "0.45em", fontFamily: "monospace", fontWeight: 700 }}
            />
            {passwordFields}
            {error && <p style={{ ...ERR, margin: 0 }}>{error}</p>}
            <EnkiCardButton type="submit" disabled={busy || code.length !== 7 || !pw || !pw2 || !!pwProblem}>
              {busy ? "Updating…" : "Set new password"}
            </EnkiCardButton>
            <button type="button" onClick={sendCode} disabled={busy}
              style={{ background: "none", border: "none", color: "rgba(245,242,236,0.5)", fontSize: 12.5, cursor: "pointer", textDecoration: "underline" }}>
              Send a new code
            </button>
          </form>
        )}
      </EnkiCardPage>
    );
  }

  // ── Guardian flow ──────────────────────────────────────────────────────────
  return (
    <EnkiCardPage embed={embed} onBack={approved ? undefined : backToChoice} title={approved ? "You're approved." : request ? "Waiting for your guardians." : "Reset via guardians."} eyebrow="Enki Art · Recovery">
      {!request ? (
        <form onSubmit={(e) => { e.preventDefault(); startGuardian(); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={SUB}>
            Enter your account email.<br />
            Every guardian you set up gets a code by email, so tell them to check their inbox.<br />
            Once enough of them approve, you can set a new password.
          </p>
          <EnkiCardInput type="email" required autoFocus placeholder="you@example.com"
            value={email} onChange={(e) => setEmail(e.target.value)} />
          {error && <p style={{ ...ERR, margin: 0 }}>{error}</p>}
          <EnkiCardButton type="submit" disabled={busy || !email.includes("@")}>
            {busy ? "Starting…" : "Ask my guardians"}
          </EnkiCardButton>
        </form>
      ) : !approved ? (
        <>
          <p style={SUB}>
            Your guardians just got an email with a code and a link.<br />
            This page updates by itself, so you can simply keep it open.<br />
            Your request stays active for 24 hours, so coming back later works too.
          </p>
          <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 10 }}>
            <KeyRound size={18} style={{ color: "#e8a83a" }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: "#f5f2ec" }}>
              {progress ? `${progress.approved} of ${progress.threshold} approvals` : "Waiting…"}
            </span>
          </div>
          {error && <p style={ERR}>{error}</p>}
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); completeGuardian(); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={SUB}>
            Your guardians confirmed it&apos;s you.<br />
            Pick a new password below.
          </p>
          {passwordFields}
          {error && <p style={{ ...ERR, margin: 0 }}>{error}</p>}
          <EnkiCardButton type="submit" disabled={busy || !pw || !pw2 || !!pwProblem}>
            {busy ? "Updating…" : "Set new password"}
          </EnkiCardButton>
        </form>
      )}
    </EnkiCardPage>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  );
}
