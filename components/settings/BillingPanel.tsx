"use client";

import { useEffect, useMemo, useState } from "react";
import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Copy, Check, QrCode, X, Wallet, ArrowDownToLine, CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useSolanaAuth } from "@/hooks/useSolanaAuth";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { useToast } from "@/hooks/use-toast";
import { refreshHoldings } from "@/hooks/useHoldings";
import { getCdpSolanaAddress, requestCdpKeyExport, CDP_ADDRESS_EVENT } from "@/lib/cdp-bridge";
import SettingsSection from "@/components/settings/SettingsSection";

/**
 * Deposit Crypto — for wallet users who already hold USDC and want to send it
 * to their own address directly. Adding money with a card lives in the
 * Payment panel's "Add money & cash out" section (Coinbase ramp).
 */
export default function BillingPanel() {
  const account = useActiveAccount();
  const { connected: solanaConnected } = useWallet();
  const { address: cdpAddress } = useCdpAddress();
  // Session-backed Solana identity: the adapter is disconnected after a page
  // load (autoConnect off) but the signed session persists — without it,
  // logged-in wallet users saw no deposit section.
  const { isAuthenticated: solanaSessionActive, walletAddress: solanaSessionAddress } = useSolanaAuth();
  const { toast } = useToast();

  // Email users get a CDP embedded wallet — its address arrives via the
  // bridge (the CDP provider tree lives outside this component), which is
  // what useCdpAddress above already subscribes to.
  const { isAuthed: emailAuthed, email } = useEmailAuth();

  const walletLogin = Boolean(account?.address) || solanaConnected || solanaSessionActive || (emailAuthed && !!cdpAddress);
  const recipient =
    account?.address ??
    (solanaSessionActive ? solanaSessionAddress : null) ??
    cdpAddress ??
    cdpAddress ??
    null;

  const [depositOpen, setDepositOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Self-custody key export (email/CDP wallets): password re-check → reveal.
  const [exportStep, setExportStep] = useState<null | "password" | "reveal">(null);
  const [exportPw, setExportPw] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [privKey, setPrivKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const closeExport = () => {
    // The key never outlives the dialog.
    setExportStep(null); setExportPw(""); setExportErr(null); setPrivKey(null); setKeyCopied(false);
  };
  const confirmExport = async () => {
    setExportBusy(true);
    setExportErr(null);
    try {
      // Re-check the account password — nobody walks up to an open laptop
      // and walks away with the key.
      const res = await fetch("/api/auth/password/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: exportPw }),
      });
      if (!res.ok) throw new Error("Wrong password");
      const key = await requestCdpKeyExport();
      setPrivKey(key);
      setExportStep("reveal");
      setExportPw("");
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExportBusy(false);
    }
  };
  const copyKey = async () => {
    if (!privKey) return;
    try {
      await navigator.clipboard.writeText(privKey);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 1600);
    } catch {
      toast({ title: "Copy failed", description: "Select and copy it manually.", variant: "destructive" });
    }
  };
  const copyAddress = async () => {
    if (!recipient) return;
    try {
      await navigator.clipboard.writeText(recipient);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({ title: "Copy failed", description: "Copy the address manually.", variant: "destructive" });
    }
  };

  const shortAddr = useMemo(
    () => (recipient ? `${recipient.slice(0, 6)}…${recipient.slice(-4)}` : "—"),
    [recipient]
  );

  return (
    <>
      {/* ── Deposit crypto — wallet users only ── */}
      {walletLogin && (
        <SettingsSection num="04" title="Deposit Crypto">
          <div className="set-section-desc" style={{ paddingBottom: 16 }}>
            Got USDC in another wallet? Send it straight to your address here.
            Use the Solana network only, anything else can get lost.
          </div>
          <div className="set-list-item">
            <div className="set-item-icon"><Wallet size={14} /></div>
            <div className="set-item-content">
              <div className="set-item-title">Your wallet address</div>
              <div className="set-item-sub" style={{ fontFamily: "monospace" }}>{shortAddr}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="set-btn set-btn-outline" onClick={copyAddress} disabled={!recipient}>
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
              </button>
              <button className="set-btn set-btn-dark" onClick={() => setDepositOpen(true)} disabled={!recipient}>
                <QrCode size={14} /> Show QR
              </button>
            </div>
          </div>
          {/* Self-custody: email wallets can export their private key. Wallet
              logins (Solflare & co) hold their keys themselves already. */}
          {emailAuthed && (
            <div className="set-list-item">
              <div className="set-item-icon"><KeyRound size={14} /></div>
              <div className="set-item-content">
                <div className="set-item-title">Your private key</div>
                <div className="set-item-sub">
                  This wallet is fully yours. Export the key and you can open it in any Solana wallet app.
                </div>
              </div>
              <button
                className="set-btn set-btn-outline"
                onClick={() => setExportStep("password")}
                disabled={!cdpAddress}
                title={cdpAddress ? "Export your private key" : "Wallet is still being set up"}
              >
                Export
              </button>
            </div>
          )}
        </SettingsSection>
      )}

      {/* ── Key export: password re-check, then the one-time reveal ── */}
      {exportStep && (
        <div className="set-pay-overlay" onClick={() => !exportBusy && closeExport()}>
          <div className="set-pay-card set-pay-card--fiat" onClick={(e) => e.stopPropagation()}>
            <button className="set-pay-close" onClick={closeExport} aria-label="Close" disabled={exportBusy}>
              <X size={16} />
            </button>
            {exportStep === "password" ? (
              <div>
                <div className="set-item-title" style={{ marginBottom: 6 }}>Confirm it&apos;s you</div>
                <p className="set-item-sub" style={{ marginBottom: 14 }}>
                  Enter your account password to reveal the private key.
                  Anyone with this key controls the money in the wallet. Never share it.
                </p>
                <input
                  type="password"
                  value={exportPw}
                  onChange={(e) => setExportPw(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && exportPw && !exportBusy) confirmExport(); }}
                  placeholder="Your password"
                  autoFocus
                  style={{
                    width: "100%", height: 40, padding: "0 12px", borderRadius: 8, fontSize: 14,
                    border: "1px solid var(--enki-rule)", background: "transparent", color: "var(--enki-ink)", outline: "none",
                  }}
                />
                {exportErr && <p style={{ fontSize: 12.5, color: "#e0584f", marginTop: 8 }}>{exportErr}</p>}
                <button
                  className="set-btn set-btn-dark"
                  style={{ width: "100%", justifyContent: "center", marginTop: 14 }}
                  onClick={confirmExport}
                  disabled={exportBusy || !exportPw}
                >
                  {exportBusy ? <Loader2 size={14} className="set-spin" /> : "Reveal key"}
                </button>
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
                  {privKey}
                </code>
                <button className="set-btn set-btn-dark" style={{ width: "100%", justifyContent: "center", marginTop: 12 }} onClick={copyKey}>
                  {keyCopied ? <Check size={14} /> : <Copy size={14} />} {keyCopied ? "Copied" : "Copy key"}
                </button>
                <button
                  className="set-btn set-btn-outline"
                  style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
                  onClick={closeExport}
                >
                  Done, close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Deposit QR modal ── */}
      {depositOpen && recipient && (
        <div className="set-pay-overlay" onClick={() => setDepositOpen(false)}>
          <div className="set-pay-card set-pay-card--qr" onClick={(e) => e.stopPropagation()}>
            <button className="set-pay-close" onClick={() => setDepositOpen(false)} aria-label="Close">
              <X size={16} />
            </button>
            <div className="set-qr-head">
              <ArrowDownToLine size={18} />
              <span>Deposit USDC · Solana</span>
            </div>
            <div className="set-qr-frame">
              <QRCodeSVG value={recipient} size={196} level="M" includeMargin />
            </div>
            <code className="set-qr-addr">{recipient}</code>
            <button className="set-btn set-btn-dark" style={{ width: "100%" }} onClick={copyAddress}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy address"}
            </button>
            <p className="set-qr-warn">Only send USDC on Solana. Anything else can get lost.</p>
          </div>
        </div>
      )}
    </>
  );
}
