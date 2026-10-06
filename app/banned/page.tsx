"use client";

/* /banned — the ONLY surface a banned account keeps. Deliberately tiny:
   status + reason, one appeal (lands in the admin panel + admin inboxes),
   and the funds truth: a ban locks the marketplace, never the wallet. */

import { useEffect, useState } from "react";
/* Defines `.ek-app` and the --enki-* tokens this page paints with — without it
   they fall back to the globals.css copy, which has no purple variant. */
import "@/components/enki-shell/enki-shell.css";
/* The .set-send* rules SendUsdcPanel paints with. */
import "@/components/settings/settings.css";
import { sessionAuthHeaders } from "@/lib/session-headers";
import SendUsdcPanel from "@/components/settings/SendUsdcPanel";
import KeyExport from "@/components/settings/KeyExport";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { useCdpAddress } from "@/hooks/useCdpAddress";

type BanMe = {
  banned: boolean; reason?: string | null; permanent?: boolean; expiresAt?: string | null;
  appeal?: { status: string; at: string; notes: string | null } | null;
  wallets?: { address: string; external: boolean; chain: string }[];
};

const MONO = "var(--font-mono), monospace";
const SERIF = "var(--font-serif), Georgia, serif";
const micro: React.CSSProperties = { fontFamily: MONO, fontSize: 8, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--enki-ink-3)" };
const card: React.CSSProperties = { border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 14, background: "var(--enki-paper)", padding: "18px 20px", textAlign: "left" };

export default function BannedPage() {
  const [me, setMe] = useState<BanMe | null | "unauth">(null);
  const [statement, setStatement] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { email } = useEmailAuth();
  const { address: cdpAddress } = useCdpAddress();

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/ban/me", { headers: sessionAuthHeaders() });
        if (res.status === 401) { setMe("unauth"); return; }
        setMe(await res.json());
      } catch { setMe("unauth"); }
    })();
  }, []);

  const submitAppeal = async () => {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/ban/appeal", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ statement }),
      });
      const d = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) { setMsg(d.error || "That didn't work — try again."); return; }
      setMe((cur) => (cur && cur !== "unauth" ? { ...cur, appeal: { status: "pending", at: new Date().toISOString(), notes: null } } : cur));
      setMsg("Appeal filed — the admin council was notified.");
    } catch {
      setMsg("Network hiccup — nothing was sent.");
    } finally {
      setBusy(false);
    }
  };

  const external = (me && me !== "unauth" && me.wallets?.filter((w) => w.external)) || [];
  // The embedded (Enki) wallet: its funds leave through the same server-built,
  // ban-tolerant Send USDC the settings page uses (BAN-3).
  const embedded = (me && me !== "unauth" && me.wallets?.find((w) => !w.external && w.chain === "solana")) || null;

  return (
    <div className="ek-app" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "var(--enki-paper-2)", color: "var(--enki-ink)" }}>
      <div style={{ width: 480, maxWidth: "94vw", display: "flex", flexDirection: "column", gap: 10 }}>
        {me === null && (
          <div style={{ ...card, textAlign: "center", fontFamily: MONO, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--enki-ink-3)" }}>Checking your account…</div>
        )}
        {me === "unauth" && (
          <div style={{ ...card, textAlign: "center" }}>
            <h1 style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 24, fontWeight: 400, margin: "0 0 6px" }}>Sign in first.</h1>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--enki-ink-3)", lineHeight: 1.6 }}>
              Log in from the <a href="/" style={{ color: "var(--enki-ember)" }}>landing page</a> to see your account status.
            </p>
          </div>
        )}
        {me !== null && me !== "unauth" && !me.banned && (
          <div style={{ ...card, textAlign: "center" }}>
            <h1 style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 24, fontWeight: 400, margin: "0 0 6px" }}>You&apos;re not banned.</h1>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--enki-ink-3)" }}>
              Everything is fine with this account — <a href="/home" style={{ color: "var(--enki-ember)" }}>back to Enki Art</a>.
            </p>
          </div>
        )}
        {me !== null && me !== "unauth" && me.banned && (
          <>
            <div style={card}>
              <div style={{ ...micro, marginBottom: 6 }}>Account status</div>
              <h1 style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 30, fontWeight: 400, margin: "0 0 6px", color: "var(--enki-danger)" }}>Banned.</h1>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--enki-ink-2)", lineHeight: 1.65 }}>
                {me.reason ?? "No reason recorded."}
              </p>
              <p style={{ margin: "8px 0 0", fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-3)" }}>
                {me.permanent ? "This ban has no expiry." : `Ends ${me.expiresAt ? new Date(me.expiresAt).toLocaleDateString() : "—"}.`}
              </p>
            </div>

            <div style={card}>
              <div style={{ ...micro, marginBottom: 6 }}>Appeal</div>
              {me.appeal ? (
                <p style={{ margin: 0, fontSize: 12.5, color: "var(--enki-ink-2)", lineHeight: 1.65 }}>
                  {me.appeal.status === "pending" && "Your appeal is with the admin council. Every decision is made by named admins and logged."}
                  {me.appeal.status === "denied" && <>Your appeal was denied.{me.appeal.notes ? <> Note from the council: “{me.appeal.notes}”</> : null}</>}
                  {me.appeal.status === "approved" && "Your appeal was approved — sign in again."}
                  {me.appeal.status === "withdrawn" && "You withdrew your appeal."}
                </p>
              ) : (
                <>
                  <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--enki-ink-3)", lineHeight: 1.6 }}>
                    One appeal per ban. It goes straight to the admin council&apos;s inboxes; the decision is voted on and logged under the deciding admins&apos; names.
                  </p>
                  <textarea value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="Your side of the story (20–2000 characters)…" rows={4}
                    style={{ width: "100%", boxSizing: "border-box", border: "1px solid var(--enki-rule)", borderRadius: 10, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 12.5, padding: "9px 11px", outline: "none", resize: "vertical", fontFamily: "inherit" }} />
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                    <button onClick={() => void submitAppeal()} disabled={busy || statement.trim().length < 20}
                      style={{ padding: "8px 18px", borderRadius: 999, border: "none", background: "var(--enki-ink)", color: "var(--enki-paper)", fontSize: 12, fontWeight: 600, cursor: busy || statement.trim().length < 20 ? "default" : "pointer", opacity: busy || statement.trim().length < 20 ? 0.5 : 1 }}>
                      {busy ? "Sending…" : "File the appeal"}
                    </button>
                    <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{statement.trim().length}/2000</span>
                  </div>
                </>
              )}
              {msg && <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--enki-ember)" }}>{msg}</p>}
            </div>

            <div style={card}>
              <div style={{ ...micro, marginBottom: 6 }}>Your funds</div>
              <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--enki-ink-2)", lineHeight: 1.65 }}>
                A ban locks the marketplace — never your wallet. Your funds stay yours, always.
              </p>
              {external.length > 0 ? (
                <>
                  <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--enki-ink-3)", lineHeight: 1.6 }}>
                    Your wallet{external.length > 1 ? "s are" : " is"} self-custodial — the keys were never with us. Open it in any Solana wallet app (Phantom, Solflare…) and move funds wherever you want:
                  </p>
                  {external.map((w) => (
                    <div key={w.address} style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--enki-ink-2)", padding: "4px 0", wordBreak: "break-all" }}>{w.address}</div>
                  ))}
                </>
              ) : embedded ? (
                <>
                  <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--enki-ink-3)", lineHeight: 1.6 }}>
                    Your account uses an embedded wallet. Send its USDC to any Solana wallet below — your wallet signs, Enki pays the network fee. Or export the key and take the whole wallet with you. Nothing is ever withheld.
                  </p>
                  <SendUsdcPanel fromAddress={embedded.address} />
                  <KeyExport email={email} ready={!!cdpAddress} />
                </>
              ) : (
                <p style={{ margin: 0, fontSize: 12, color: "var(--enki-ink-3)", lineHeight: 1.6 }}>
                  No wallet is attached to this account, so there is nothing to move. Nothing is ever withheld.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
