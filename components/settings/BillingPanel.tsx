"use client";

import { useEffect, useMemo, useState } from "react";
import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Copy, Check, QrCode, X, Wallet, ArrowDownToLine, CheckCircle2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useSolanaAuth } from "@/hooks/useSolanaAuth";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { useToast } from "@/hooks/use-toast";
import { refreshHoldings } from "@/hooks/useHoldings";
import { getCdpSolanaAddress, CDP_ADDRESS_EVENT } from "@/lib/cdp-bridge";
import KeyExport from "@/components/settings/KeyExport";
import SettingsSection from "@/components/settings/SettingsSection";

/**
 * Deposit Crypto — for wallet users who already hold USDC and want to send it
 * to their own address directly. Adding money with a card lives in the
 * Payment panel's "Add money & cash out" section (Coinbase ramp).
 */
export default function BillingPanel() {
  const account = useActiveAccount();
  const { connected: solanaConnected } = useWallet();
  const { address: cdpAddress, evmAddress: cdpEvmAddress } = useCdpAddress();
  // Session-backed Solana identity: the adapter is disconnected after a page
  // load (autoConnect off) but the signed session persists — without it,
  // logged-in wallet users saw no deposit section.
  const { isAuthenticated: solanaSessionActive, walletAddress: solanaSessionAddress } = useSolanaAuth();
  const { toast } = useToast();

  // Email users get a CDP embedded wallet — its address arrives via the
  // bridge (the CDP provider tree lives outside this component), which is
  // what useCdpAddress above already subscribes to.
  const { isAuthed: emailAuthed } = useEmailAuth();

  const walletLogin = Boolean(account?.address) || solanaConnected || solanaSessionActive || (emailAuthed && !!cdpAddress);
  const recipient =
    account?.address ??
    (solanaSessionActive ? solanaSessionAddress : null) ??
    cdpAddress ??
    cdpAddress ??
    null;

  const [depositOpen, setDepositOpen] = useState(false);
  const [copied, setCopied] = useState(false);
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
          {/* EVM address (CDP-1, multichain starting point): CDP provisions an
              EVM EOA alongside the Solana account. Read-only / informational
              only — this wallet is Solana-primary, no deposit/QR actions
              against it yet. */}
          {emailAuthed && cdpEvmAddress && (
            <div className="set-list-item">
              <div className="set-item-icon"><Wallet size={14} /></div>
              <div className="set-item-content">
                <div className="set-item-title">
                  EVM address <span className="set-badge-muted">Informational</span>
                </div>
                <div className="set-item-sub" style={{ fontFamily: "monospace" }}>{cdpEvmAddress}</div>
              </div>
            </div>
          )}
          {/* Self-custody: email wallets can export their private key. Wallet
              logins (Solflare & co) hold their keys themselves already. */}
          {emailAuthed && <KeyExport ready={!!cdpAddress} />}
        </SettingsSection>
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
