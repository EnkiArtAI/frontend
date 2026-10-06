"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import type { WalletName } from "@solana/wallet-adapter-base";
import { createSolanaAuthSession, createSolanaAuthSessionWithSignIn } from "@/hooks/useSolanaAuth";
import { Loader2, Check, X } from "lucide-react";

// Matches the landing's auth-modal design language (public/landing.html): a
// dark #0E0E12 panel with the ember/gold gradient, so the wallet list feels
// like part of Enki, not a generic shadcn dialog.
const PICKER_CSS = `
.wp-scope { font-family: var(--font-dm-sans), 'DM Sans', system-ui, sans-serif; }
.wp-title { color:#fff; font-weight:800; letter-spacing:-0.02em; font-size:1.2rem; }
.wp-sub { color:rgba(244,238,232,0.45); font-size:0.75rem; }
.wp-badge { display:inline-flex; align-items:center; gap:5px; border:1px solid rgba(232,168,58,0.35); border-radius:20px; padding:2px 9px; font-size:10px; font-weight:700; letter-spacing:0.04em; color:#ffd9a0; }
.wp-dot { width:6px; height:6px; border-radius:50%; background:linear-gradient(135deg,#d9863f,#e8a83a); }
.wp-row { display:flex; width:100%; align-items:center; gap:12px; padding:11px 12px; border:none; border-radius:12px; background:transparent; cursor:pointer; text-align:left; font-family:inherit; transition:background .15s; }
.wp-row:hover:not(:disabled) { background:rgba(244,238,232,0.05); }
.wp-row:disabled { opacity:.45; cursor:default; }
.wp-name { color:rgba(244,238,232,0.95); font-size:0.9rem; font-weight:600; }
.wp-ico { width:32px; height:32px; border-radius:9px; flex-shrink:0; object-fit:cover; }
.wp-ico-fallback { background:linear-gradient(135deg,#d9863f,#e8a83a); }
.wp-arrow { color:rgba(244,238,232,0.28); font-size:20px; line-height:1; flex-shrink:0; }
.wp-status { display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:700; color:#ffd9a0; flex-shrink:0; }
.wp-install { font-size:11px; font-weight:600; color:rgba(244,238,232,0.4); flex-shrink:0; }
.wp-empty { border:1px dashed rgba(244,238,232,0.16); border-radius:14px; padding:22px 18px; text-align:center; }
.wp-empty a { color:#ffd9a0; text-decoration:none; }
.wp-empty a:hover { text-decoration:underline; }
.wp-err { border-radius:10px; background:rgba(239,68,68,0.12); color:#fca5a5; font-size:0.72rem; padding:8px 12px; }
.wp-foot { text-align:center; color:rgba(244,238,232,0.38); font-size:11px; }
.wp-spin { animation:wpspin .7s linear infinite; }
@keyframes wpspin { to { transform:rotate(360deg); } }
.wp-result { display:flex; flex-direction:column; align-items:center; gap:10px; padding:22px 12px 14px; text-align:center; }
.wp-badge-ok, .wp-badge-no { width:54px; height:54px; border-radius:50%; display:flex; align-items:center; justify-content:center; }
.wp-badge-ok { background:rgba(16,185,129,0.15); color:#34d399; }
.wp-badge-no { background:rgba(239,68,68,0.15); color:#f87171; }
.wp-result-title { color:#fff; font-weight:800; font-size:1.05rem; letter-spacing:-0.01em; }
.wp-result-sub { color:rgba(244,238,232,0.5); font-size:0.8rem; line-height:1.5; max-width:260px; }
.wp-pop { animation:wppop .35s cubic-bezier(0.34,1.56,0.64,1) both; }
@keyframes wppop { from { transform:scale(0.5); opacity:0; } to { transform:scale(1); opacity:1; } }
`;

interface WalletPickerModalProps {
  open: boolean;
  onClose: () => void;
}

type SolanaPhase = "connecting" | "signing";

function isUserRejection(e: unknown): boolean {
  const raw = ((e as Error)?.message ?? String(e ?? "")).toLowerCase();
  if (!raw) return false;
  return (
    raw.includes("user reject") ||
    raw.includes("user denied") ||
    raw.includes("user cancel") ||
    raw.includes("user closed") ||
    raw.includes("rejected the request") ||
    raw.includes("connection rejected") ||
    raw.includes("request rejected") ||
    raw.includes("popup closed") ||
    raw.includes("walletconnect modal closed") ||
    // Solflare says just "Cancelled" / "Transaction cancelled" (no "user" prefix)
    raw.includes("cancel") ||
    raw.includes("declined") ||
    (e as { code?: number })?.code === 4001
  );
}

/**
 * External Solana-wallet connect (Wallet Standard), for users who bring their
 * own wallet. Solana-only: Enki launches payments exclusively on Solana first,
 * so no EVM path here. Email/password users get a Privy embedded wallet via
 * AuthModal instead. Slim, Enki-styled.
 */
export function WalletPickerModal({ open, onClose }: WalletPickerModalProps) {
  const {
    wallets: solanaWallets,
    wallet: solanaWallet,
    select: selectSolanaWallet,
  } = useWallet();

  const [connecting, setConnecting] = useState<string | null>(null);
  const [solanaPhase, setSolanaPhase] = useState<SolanaPhase | null>(null);
  const [solanaError, setSolanaError] = useState<string | null>(null);
  // Terminal states shown briefly before redirect (success) or reset (denied).
  const [result, setResult] = useState<"success" | "denied" | null>(null);
  const solanaInFlight = useRef(false);
  // Bumped on close and on every new connect attempt: an async flow that
  // awaited a wallet popup across a close/reopen is superseded and must not
  // keep signing, writing state, or closing the new flow's modal.
  const flowSeq = useRef(0);

  const wallets = useMemo(
    () =>
      solanaWallets.map((w) => ({
        name: w.adapter.name,
        icon: w.adapter.icon ?? "",
        detected:
          w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable,
      })),
    [solanaWallets],
  );

  const handleClose = useCallback(() => {
    flowSeq.current += 1;
    solanaInFlight.current = false;
    setSolanaPhase(null);
    setSolanaError(null);
    setConnecting(null);
    setResult(null);
    onClose();
  }, [onClose]);

  // Fresh slate on every open: a previous attempt that was cancelled/superseded
  // must never leave the picker stuck (bump flowSeq to stale any lingering flow,
  // release the in-flight lock). Without this a leaked lock forced a full reload.
  useEffect(() => {
    if (!open) return;
    flowSeq.current += 1;
    solanaInFlight.current = false;
    setConnecting(null);
    setSolanaPhase(null);
    setSolanaError(null);
    setResult(null);
  }, [open]);

  const handleSolana = async (name: string) => {
    const found = solanaWallets.find((w) => w.adapter.name === name);
    if (!found) return;

    if (
      found.readyState === WalletReadyState.NotDetected ||
      found.readyState === WalletReadyState.Unsupported
    ) {
      window.open(found.adapter.url, "_blank");
      return;
    }

    // Re-clicking the wallet we're already trying is a no-op; clicking ANY other
    // wallet supersedes the in-flight attempt (bumping flowSeq stales it) instead
    // of being silently dropped — so the picker can never get stuck.
    if (connecting === name) return;

    const flow = ++flowSeq.current;
    const stale = () => flowSeq.current !== flow;
    solanaInFlight.current = true;
    setSolanaError(null);
    setConnecting(name);
    setSolanaPhase("connecting");

    const adapter = found.adapter;

    // Some adapters (e.g. Zerion) expose signIn but throw "Not Implemented";
    // fall back to plain signMessage for those. IMPORTANT: judge by the
    // MESSAGE only — Solflare wraps a user CANCEL in WalletSignInError too,
    // and treating that as "unsupported" popped a second sign prompt.
    const isSignInUnsupported = (e: unknown): boolean => {
      const msg = ((e as Error)?.message ?? "").toLowerCase();
      return msg.includes("not implemented") || msg.includes("not supported") || msg.includes("signin is not");
    };

    try {
      // Disconnect a previously-active different adapter so its disconnect
      // listener doesn't interfere with this connect popup.
      if (solanaWallet && solanaWallet.adapter.name !== name) {
        try { await solanaWallet.adapter.disconnect(); } catch { /* noop */ }
      }
      // Keep WalletProvider state in sync for Navbar / hooks (sync, no connect).
      selectSolanaWallet(name as WalletName);

      if (!adapter.connected) await adapter.connect();
      if (stale()) { try { await adapter.disconnect(); } catch { /* noop */ } return; }

      const publicKey = adapter.publicKey;
      if (!publicKey) throw new Error("Wallet did not return a public key");
      setSolanaPhase("signing");
      const walletAddress = publicKey.toBase58();

      type SignInInput = {
        domain?: string; address?: string; statement?: string; uri?: string;
        version?: string; chainId?: string; nonce?: string; issuedAt?: string;
      };
      type SignInFn = (input?: SignInInput) => Promise<{ signedMessage: Uint8Array; signature: Uint8Array }>;
      type SignMessageFn = (message: Uint8Array) => Promise<Uint8Array>;
      const capable = adapter as unknown as { signIn?: SignInFn; signMessage?: SignMessageFn };

      let authenticated = false;
      if (typeof capable.signIn === "function") {
        try {
          await createSolanaAuthSessionWithSignIn(walletAddress, capable.signIn.bind(adapter));
          authenticated = true;
        } catch (signInErr) {
          if (isUserRejection(signInErr) || !isSignInUnsupported(signInErr)) throw signInErr;
        }
      }
      if (!authenticated) {
        if (typeof capable.signMessage === "function") {
          await createSolanaAuthSession(walletAddress, capable.signMessage.bind(adapter));
        } else {
          throw new Error("Wallet does not support message signing");
        }
      }
      if (stale()) return;
      // Green check, then straight to the app (the login set the gate cookie).
      setResult("success");
      setTimeout(() => { window.location.href = "/home"; }, 750);
    } catch (e) {
      if (stale()) return;
      // Only disconnect a wallet that actually connected — Solflare throws
      // WalletDisconnectionError("Record not found") otherwise (console noise).
      if (adapter.connected) { try { await adapter.disconnect(); } catch { /* noop */ } }
      if (isUserRejection(e)) {
        setSolanaError(null); // user cancelled — silent, just reset (see finally)
      } else if ((e as { notWhitelisted?: boolean })?.notWhitelisted) {
        setResult("denied");
        setTimeout(() => { if (!stale()) handleClose(); }, 2200);
      } else {
        const raw = (e as Error)?.message ?? String(e ?? "");
        const lower = raw.toLowerCase();
        const hint =
          name === "Solflare" && (lower.includes("rejected") || lower.includes("connection rejected"))
            ? " Open the Solflare extension, unlock it, then revoke any localhost entries under Settings → Trusted Apps and retry."
            : "";
        console.error(`[Solana connect/sign-in] adapter=${name} raw=`, e);
        setSolanaError(`Couldn't connect (${name}): ${raw || "unknown error"}.${hint}`);
      }
    } finally {
      // The current flow ALWAYS releases the lock + clears the spinner, so no exit
      // path can leave the picker stuck. A superseded (stale) flow leaves the new
      // flow's state untouched.
      if (!stale()) {
        solanaInFlight.current = false;
        setConnecting(null);
        setSolanaPhase(null);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      {/* Backdrop = the landing login card's .auth-backdrop, continued: same
          navy, same blur, same layer (2000, above every piece of app chrome).
          Reached from the login card, the page therefore stays muted instead
          of snapping back to full brightness (Kev, 2026-09-05). */}
      <DialogContent
        overlayClassName="z-[2000] bg-[rgba(0,4,24,0.75)] backdrop-blur-[10px]"
        className="sm:max-w-[400px] gap-0 border-0 p-0 overflow-hidden z-[2001]"
        style={{
          background: "#0E0E12",
          border: "1px solid rgba(232,168,58,0.18)",
          borderRadius: 20,
          color: "rgb(244,238,232)",
          boxShadow: "0 32px 80px rgba(0,0,0,0.7)",
        }}
      >
        <style dangerouslySetInnerHTML={{ __html: PICKER_CSS }} />
        <div className="wp-scope" style={{ padding: "26px 28px" }}>
          {result === "success" ? (
            <>
              <DialogTitle className="sr-only">Signed in</DialogTitle>
              <div className="wp-result">
                <span className="wp-badge-ok wp-pop"><Check size={28} strokeWidth={3} /></span>
                <div className="wp-result-title">You&rsquo;re in</div>
                <div className="wp-result-sub">Taking you home…</div>
              </div>
            </>
          ) : result === "denied" ? (
            <>
              <DialogTitle className="sr-only">Not allowed</DialogTitle>
              <div className="wp-result">
                <span className="wp-badge-no wp-pop"><X size={28} strokeWidth={3} /></span>
                <div className="wp-result-title">Not allowed yet</div>
                <div className="wp-result-sub">This wallet isn&rsquo;t on the access list. Request access to join.</div>
              </div>
            </>
          ) : (
          <>
          <DialogHeader className="mb-4 space-y-1 text-left">
            <div className="flex items-center gap-2">
              <DialogTitle className="wp-title">Connect a wallet</DialogTitle>
              <span className="wp-badge"><span className="wp-dot" /> SOLANA</span>
            </div>
            <DialogDescription className="wp-sub">
              Use a Solana wallet you already own.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1">
            {solanaError && <p className="wp-err">{solanaError}</p>}

            {wallets.length === 0 ? (
              <div className="wp-empty">
                <p style={{ color: "rgba(244,238,232,0.9)", fontSize: "0.85rem", fontWeight: 600 }}>No wallets detected</p>
                <p style={{ marginTop: 6, color: "rgba(244,238,232,0.45)", fontSize: "0.75rem", lineHeight: 1.5 }}>
                  Install{" "}
                  <a href="https://phantom.app" target="_blank" rel="noreferrer">Phantom</a>,{" "}
                  <a href="https://solflare.com" target="_blank" rel="noreferrer">Solflare</a>{" "}
                  or another Solana wallet, then reopen this.
                </p>
              </div>
            ) : (
              /* One row per Solana wallet (Wallet Standard, auto-detected). The
                 whole row connects; undetected wallets open their install page. */
              wallets.map((w) => {
                const isConnecting = connecting === w.name;
                return (
                  <button
                    key={w.name}
                    className="wp-row"
                    disabled={!!connecting && !isConnecting}
                    onClick={() => handleSolana(w.name)}
                  >
                    {w.icon ? (
                      <img
                        src={w.icon}
                        alt={w.name}
                        className="wp-ico"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    ) : (
                      <span className="wp-ico wp-ico-fallback" />
                    )}
                    <span className="wp-name flex-1 truncate">{w.name}</span>
                    {isConnecting ? (
                      <span className="wp-status">
                        <Loader2 size={13} className="wp-spin" />
                        {solanaPhase === "signing" ? "Sign in…" : "Connecting…"}
                      </span>
                    ) : w.detected ? (
                      <span className="wp-arrow">›</span>
                    ) : (
                      <span className="wp-install">Install ↗</span>
                    )}
                  </button>
                );
              })
            )}

            <p className="wp-foot" style={{ marginTop: 14 }}>Non-custodial — you keep your keys.</p>
          </div>
          </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
