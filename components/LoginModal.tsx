"use client";

import { useEffect, useRef, useState } from "react";
import { WalletPickerModal } from "@/components/WalletPickerModal";

/**
 * THE login popup — pluggable anywhere (Kev, 2026-08-24: "come up with a
 * composable way how we can plug and play that UI login form").
 *
 * It does not rebuild the auth form. It mounts the landing's own modal in a
 * transparent iframe (/landing.html?modal=1 renders nothing but the modal),
 * so email/password, Request access, the tabs and every future change to
 * that form appear here automatically — one login UI, zero drift. The
 * page's "Continue with Wallet" already postMessages enki-open-wallet; here
 * that opens the wallet picker in the same overlay.
 *
 * SPEED (Kev, 2026-08-24: "dauert viel zu lange"): the iframe carries a
 * whole page, so it is PREWARMED — mounted invisibly moments after a guest
 * shell settles — and kept alive after closing. Opening then only flips
 * visibility and re-asks the frame to show its modal.
 */
export default function LoginModal({ open, onClose, prewarm = false }: {
  open: boolean;
  onClose: () => void;
  /** Load the frame invisibly ahead of time (pass while the viewer is a guest). */
  prewarm?: boolean;
}) {
  const [walletOpen, setWalletOpen] = useState(false);
  const [warm, setWarm] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Warm up shortly after mount — never in the shell's critical first paint.
  useEffect(() => {
    if (!prewarm || warm) return;
    const t = window.setTimeout(() => setWarm(true), 1200);
    return () => window.clearTimeout(t);
  }, [prewarm, warm]);
  useEffect(() => { if (open) setWarm(true); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMessage = (e: MessageEvent) => {
      const t = (e.data as { type?: string } | null)?.type;
      if (t === "enki-login-close") onClose();
      if (t === "enki-open-wallet") setWalletOpen(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, onClose]);

  // A re-open after a close inside the frame (backdrop click) must re-open
  // the frame's modal — the frame stays warm, so ask it instead of reloading.
  useEffect(() => {
    if (open) frameRef.current?.contentWindow?.postMessage({ type: "enki-open-login" }, "*");
  }, [open]);

  if (!warm && !open) return null;

  const shown = open && !walletOpen;
  return (
    <>
      {/* The login card mutes the whole page (the frame's backdrop). Handing
          over to the wallet picker hides the frame; the picker's own backdrop
          is styled as the same layer (colour, blur, z 2000 — see
          WalletPickerModal), so the page stays muted through the handover
          instead of snapping back to full brightness (Kev, 2026-09-05). */}
      <iframe
        ref={frameRef}
        src="/landing.html?modal=1"
        title="Log in"
        style={{
          position: "fixed", inset: 0, width: "100%", height: "100%",
          border: "none", zIndex: 2000, background: "transparent",
          visibility: shown ? "visible" : "hidden",
          pointerEvents: shown ? "auto" : "none",
        }}
      />
      <WalletPickerModal open={open && walletOpen} onClose={() => { setWalletOpen(false); onClose(); }} />
    </>
  );
}
