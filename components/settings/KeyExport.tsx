"use client";

/* Self-custody key export for embedded (email) wallets (CDP-1: migrated to
   CDP's secure export iframe — the key copies straight to the clipboard
   inside Coinbase's own iframe and never reaches this component's JS at all,
   replacing the deprecated useExportSolanaAccount path that used to hand us
   the raw string). The user confirms with their second factor first, when
   they set one up (step-up "export", which also mails them a notice), then
   this registers a container with the CDP bridge; CdpWalletBridge portals
   the iframe's own button into it. Settings and /banned share this
   component: a ban locks the marketplace, never the wallet. Wallet logins
   (Phantom & co) hold their keys themselves already. */

import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, X } from "lucide-react";
import { ensureCdpWallet, setExportIframeContainer, getExportIframeStatus, CDP_EXPORT_IFRAME_EVENT } from "@/lib/cdp-bridge";
import { useStepUp } from "@/components/StepUpProvider";

export default function KeyExport({ ready }: { ready: boolean }) {
  const { confirm } = useStepUp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // While the dialog is open, the container is registered with the bridge so
  // CdpWalletBridge can portal CDP's own export button into it; closing (or
  // unmounting) unregisters it. The bridge relays the iframe's live status
  // back so this dialog can show a spinner/error line around CDP's button.
  useEffect(() => {
    if (!open) return;
    setExportIframeContainer(containerRef.current);
    const onChange = () => {
      const s = getExportIframeStatus();
      setStatus(s.status);
      if (s.status === "error") setErr(s.message || "Export failed");
    };
    window.addEventListener(CDP_EXPORT_IFRAME_EVENT, onChange);
    onChange();
    return () => {
      setExportIframeContainer(null);
      window.removeEventListener(CDP_EXPORT_IFRAME_EVENT, onChange);
    };
  }, [open]);

  const close = () => {
    setOpen(false); setErr(null); setStatus(null); setBusy(false);
  };
  const reveal = async () => {
    setBusy(true);
    setErr(null);
    try {
      // The second factor first, when there is one: nobody walks up to an open
      // laptop and walks away with the key. Asked before the overlay opens,
      // which would cover the step-up dialog. The lock check that used to run
      // inside requestCdpKeyExport now runs here, since that function is gone.
      if (!(await confirm("export"))) return;
      await ensureCdpWallet();
      setOpen(true);
    } catch (e) {
      setOpen(true);
      setErr(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(false);
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
            <div>
              <div className="set-item-title" style={{ marginBottom: 6 }}>Your private key</div>
              <p className="set-item-sub" style={{ marginBottom: 12 }}>
                Click the button below to copy your key straight to your clipboard — it goes through
                Coinbase&apos;s own secure export, so we never see or keep it. Then paste it into a Solana
                wallet app (Phantom or Solflare) to import this wallet there, with the same address and
                the same USDC (on Solana) you have here.
              </p>
              {/* CDP's own secure iframe button renders here (CdpWalletBridge
                  portals it in once this container is registered). Nothing
                  in this component ever sees the key itself — this div is
                  left empty on our side so the portal is the only thing that
                  ever manages its children. */}
              {status === null && <Loader2 size={16} className="set-spin" />}
              <div ref={containerRef} style={{ minHeight: 40 }} />
              {err && <p style={{ fontSize: 12.5, color: "#e0584f", marginTop: 8 }}>{err}</p>}
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
          </div>
        </div>
      )}
    </>
  );
}
