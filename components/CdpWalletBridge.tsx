"use client";

import { useEffect, useRef } from "react";
import { useIsSignedIn, useAuthenticateWithJWT, useSolanaAddress, useEvmAddress, useExportSolanaAccount, useSignSolanaTransaction } from "@coinbase/cdp-hooks";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { sessionAuthHeaders } from "@/lib/session-headers";
import {
  setCdpSolanaAddress,
  CDP_EXPORT_REQUEST,
  CDP_EXPORT_RESULT,
  CDP_SIGN_REQUEST,
  CDP_SIGN_RESULT,
} from "@/lib/cdp-bridge";

/**
 * Bridges our email+password session to CDP. Renders nothing — provisions the
 * wallet invisibly (no connect step the user notices):
 *
 *  1. email session + CDP signed out → authenticateWithJWT() (uses our JWT via
 *     the provider's customAuth.getJwt) → CDP provisions Solana + EVM wallets.
 *  2. wallet ready → POST the addresses to the server, which writes the Solana
 *     address into auth_sessions (+ user_wallets), replacing the users.id bridge
 *     value from email login.
 *
 * Logout needs no step here: the runtime unmounts with the email session.
 */
export function CdpWalletBridge() {
  const { isAuthed } = useEmailAuth();
  const { isSignedIn } = useIsSignedIn();
  const { authenticateWithJWT } = useAuthenticateWithJWT();
  const { solanaAddress } = useSolanaAddress();
  const { evmAddress } = useEvmAddress();
  const { exportSolanaAccount } = useExportSolanaAccount();
  const { signSolanaTransaction } = useSignSolanaTransaction();
  const signingIn = useRef(false);
  const attachedFor = useRef<string | null>(null);

  // Publish the address to the app outside this provider tree (deposit UI).
  useEffect(() => {
    setCdpSolanaAddress(solanaAddress ?? null);
    return () => setCdpSolanaAddress(null);
  }, [solanaAddress]);

  // Self-custody: answer key-export requests (Payment → "Your private key").
  // The requesting side asks for an "export" step-up BEFORE the request.
  useEffect(() => {
    const onRequest = async () => {
      let detail: { privateKey?: string; error?: string };
      try {
        if (!solanaAddress) throw new Error("Wallet isn't ready yet");
        const { privateKey } = await exportSolanaAccount({ solanaAccount: solanaAddress });
        detail = { privateKey };
      } catch (e) {
        detail = { error: e instanceof Error ? e.message : "Export failed" };
      }
      window.dispatchEvent(new CustomEvent(CDP_EXPORT_RESULT, { detail }));
    };
    window.addEventListener(CDP_EXPORT_REQUEST, onRequest);
    return () => window.removeEventListener(CDP_EXPORT_REQUEST, onRequest);
  }, [solanaAddress, exportSolanaAccount]);

  // Payments: sign here, inside the provider, and hand the result back out.
  // The signing hook exists only in this tree, so the payment flow asks for a
  // signature by event instead of calling the hook where there is no provider.
  useEffect(() => {
    const onRequest = async (e: Event) => {
      const req = (e as CustomEvent).detail as { id: string; transaction: string };
      let detail: { id: string; signedTransaction?: string; error?: string };
      try {
        if (!solanaAddress) throw new Error("Wallet isn't ready yet");
        const { signedTransaction } = await signSolanaTransaction({
          solanaAccount: solanaAddress,
          transaction: req.transaction,
        });
        detail = { id: req.id, signedTransaction };
      } catch (err) {
        detail = { id: req.id, error: err instanceof Error ? err.message : "Signing failed" };
      }
      window.dispatchEvent(new CustomEvent(CDP_SIGN_RESULT, { detail }));
    };
    window.addEventListener(CDP_SIGN_REQUEST, onRequest);
    return () => window.removeEventListener(CDP_SIGN_REQUEST, onRequest);
  }, [solanaAddress, signSolanaTransaction]);

  // 1) our session → CDP session (silent)
  useEffect(() => {
    if (!isAuthed || isSignedIn || signingIn.current) return;
    signingIn.current = true;
    authenticateWithJWT()
      .catch((e) => console.error("[cdp] JWT sign-in failed:", e))
      .finally(() => { signingIn.current = false; });
  }, [isAuthed, isSignedIn, authenticateWithJWT]);

  // 2) wallet ready → attach the address to our session
  useEffect(() => {
    if (!isAuthed || !isSignedIn || !solanaAddress) return;
    if (attachedFor.current === solanaAddress) return;
    attachedFor.current = solanaAddress;
    (async () => {
      try {
        const res = await fetch("/api/auth/session/attach-wallet", {
          method: "POST",
          headers: { "content-type": "application/json", ...sessionAuthHeaders() },
          body: JSON.stringify({ solanaAddress, evmAddress: evmAddress ?? null }),
        });
        if (!res.ok) attachedFor.current = null; // retry on next change
      } catch {
        attachedFor.current = null;
      }
    })();
  }, [isAuthed, isSignedIn, solanaAddress, evmAddress]);

  return null;
}
