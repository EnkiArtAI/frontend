"use client";

/* Self-custody key export for embedded (email) wallets: the user confirms with
   a second factor (step-up "export", which also mails them a notice), the key
   is shown once, and the dialog says what to do with it. Settings and /banned
   share it: a ban locks the marketplace, never the wallet. Wallet logins
   (Phantom & co) hold their keys themselves already. */

import { useState } from "react";
import { Check, Copy, KeyRound, Loader2, X } from "lucide-react";
import { requestCdpKeyExport } from "@/lib/cdp-bridge";
import { useStepUp } from "@/components/StepUpProvider";

export default function KeyExport({ ready }: { ready: boolean }) {
  const { tokenFor } = useStepUp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const close = () => {
    // The key never outlives the dialog.
    setOpen(false); setErr(null); setKey(null); setCopied(false);
  };
  const reveal = async () => {
    setBusy(true);
    setErr(null);
    try {
      // A second factor first: nobody walks up to an open laptop and walks
      // away with the key. Asked before the overlay opens, which would cover
      // the step-up dialog.
      if (!(await tokenFor("export"))) return;
      setOpen(true);
      setKey(await requestCdpKeyExport());
    } catch (e) {
      setOpen(true);
      setErr(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setErr("Copy failed — select the key and copy it manually.");
    }
  };

  return (
    <>
      <div className="set-list-item">
        <div className="set-item-icon"><KeyRound size={14} /></div>
        <div className="set-item-content">
          <div className="set-item-title">Your private key</div>
          <div className="set-item-sub">This wallet is fully yours. Export the key and you can open it in any Solana wallet app.</div>
        </div>
        <button
          className="set-btn set-btn-outline"
          onClick={() => void reveal()}
          disabled={!ready || busy}
          title={ready ? "Export your private key" : "Wallet is still being set up"}
        >
          Export
        </button>
      </div>

      {open && (
        <div className="set-pay-overlay" onClick={() => !busy && close()}>
          <div className="set-pay-card set-pay-card--fiat" onClick={(e) => e.stopPropagation()}>
            <button className="set-pay-close" onClick={close} aria-label="Close" disabled={busy}>
              <X size={16} />
            </button>
            {!key ? (
              <div>
                <div className="set-item-title" style={{ marginBottom: 6 }}>Your private key</div>
                {err
                  ? <p style={{ fontSize: 12.5, color: "#e0584f" }}>{err}</p>
                  : <Loader2 size={16} className="set-spin" />}
              </div>
            ) : (
              <div>
                <div className="set-item-title" style={{ marginBottom: 6 }}>Your private key</div>
                <p className="set-item-sub" style={{ marginBottom: 12 }}>
                  Store it somewhere safe (a password manager). It disappears when you close this window.
                  We never see or keep it.
                </p>
                <code style={{
                  display: "block", padding: 12, borderRadius: 8, fontSize: 12, lineHeight: 1.5,
                  border: "1px solid var(--enki-rule)", background: "var(--enki-paper-2)",
                  color: "var(--enki-ink)", wordBreak: "break-all", userSelect: "all",
                }}>
                  {key}
                </code>
                <button className="set-btn set-btn-dark" style={{ width: "100%", justifyContent: "center", marginTop: 12 }} onClick={() => void copy()}>
                  {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy key"}
                </button>
                {err && <p style={{ fontSize: 12.5, color: "#e0584f", marginTop: 8 }}>{err}</p>}
                <div className="set-item-title" style={{ margin: "16px 0 6px" }}>What to do with it</div>
                <ol className="set-item-sub" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                  <li>Install a Solana wallet app: Phantom or Solflare, on your phone or as a browser extension.</li>
                  <li>Choose to import an existing wallet with a private key, and paste this key.</li>
                  <li>The wallet opens with the same address and the same USDC (on Solana) you had here.</li>
                  <li>From that app you can send the USDC anywhere: to another wallet, or to an exchange that accepts USDC on Solana, to cash it out.</li>
                </ol>
                <p className="set-item-sub" style={{ margin: "10px 0 0" }}>
                  Whoever holds this key controls the money. Enki cannot undo a transfer or restore a lost key.
                </p>
                <button
                  className="set-btn set-btn-outline"
                  style={{ width: "100%", justifyContent: "center", marginTop: 12 }}
                  onClick={close}
                >
                  Done, close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
