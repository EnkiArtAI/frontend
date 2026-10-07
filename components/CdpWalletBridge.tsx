"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIsInitialized, useIsSignedIn, useSolanaAddress, useEvmAddress } from "@coinbase/cdp-hooks";
import { authenticateWithJWT, exportSolanaAccount, signSolanaTransaction } from "@coinbase/cdp-core";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { useStepUp } from "@/components/StepUpProvider";
import { sessionAuthHeaders } from "@/lib/session-headers";
import {
  setCdpSolanaAddress,
  getCdpSolanaAddress,
  isCdpLocked,
  setCdpLocked,
  registerCdpEnsure,
  rememberCdpAddress,
  rememberedCdpAddress,
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
 *  3. unlock (Kev, 2026-10-07): an account with a second factor needs a wallet
 *     step-up before CDP may act. Right after an email login (a one-shot marker
 *     from the landing) the dialog asks at once; otherwise the first wallet
 *     action asks, once, and signs in to CDP again. Without a factor nothing
 *     is ever asked.
 *
 * Sign and export use the core functions: they check the sign-in when called,
 * where the hook versions keep the state of the render that created them.
 * Logout needs no step here: the runtime unmounts with the email session.
 */
export function CdpWalletBridge() {
  const { isAuthed, email } = useEmailAuth();
  const { isInitialized } = useIsInitialized();
  const { isSignedIn } = useIsSignedIn();
  const { solanaAddress } = useSolanaAddress();
  const { evmAddress } = useEvmAddress();
  const { tokenFor } = useStepUp();
  const signingIn = useRef<Promise<unknown> | null>(null);
  const attachedFor = useRef<string | null>(null);
  const [attached, setAttached] = useState<string | null>(null);
  const ready = useRef(false);
  const waiting = useRef<(() => void)[]>([]);

  // One CDP sign-in at a time, shared by the silent path and the unlock.
  const signIn = useCallback(
    () => (signingIn.current ??= authenticateWithJWT().finally(() => { signingIn.current = null; })),
    [],
  );

  // The wallet step-up stamps this session as unlocked; then CDP signs in again.
  const unlock = useCallback(async () => {
    if (!(await tokenFor("wallet"))) throw new Error("Not confirmed, nothing was signed.");
    setCdpLocked(false);
    await signIn();
  }, [tokenFor, signIn]);

  // Resolves once CDP is signed in and its address is attached to our session.
  const ensure = useCallback(async () => {
    if (ready.current) return;
    if (!isCdpLocked()) await signIn().catch(() => { /* locked or offline: decided below */ });
    if (isCdpLocked()) await unlock();
    if (ready.current) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The wallet didn't answer. Reload and try again.")), 30_000);
      waiting.current.push(() => { clearTimeout(timer); resolve(); });
    });
  }, [signIn, unlock]);

  useEffect(() => {
    registerCdpEnsure(ensure);
    return () => registerCdpEnsure(null);
  }, [ensure]);

  useEffect(() => {
    ready.current = Boolean(isSignedIn && solanaAddress && attached === solanaAddress);
    if (!ready.current) return;
    const done = waiting.current;
    waiting.current = [];
    done.forEach((resolve) => resolve());
  }, [isSignedIn, solanaAddress, attached]);

  // A wallet action; if the server locked the wallet meanwhile (15 min idle,
  // 2 h at most), asks once and runs it again.
  const act = useCallback(async <T,>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (e) {
      if (!isCdpLocked()) throw e;
      await unlock();
      return op();
    }
  }, [unlock]);

  // Publish the address to the app outside this provider tree (deposit UI).
  // While the wallet is locked CDP has none: the last one for this email
  // stands in, so the screens can offer the action that unlocks.
  useEffect(() => {
    if (solanaAddress && email) rememberCdpAddress(email, solanaAddress);
    setCdpSolanaAddress(solanaAddress ?? (email ? rememberedCdpAddress(email) : null));
    return () => setCdpSolanaAddress(null);
  }, [solanaAddress, email]);

  // Self-custody: answer key-export requests (Payment → "Your private key").
  // The requesting side confirms with the second factor BEFORE the request.
  useEffect(() => {
    const onRequest = async () => {
      let detail: { privateKey?: string; error?: string };
      try {
        const solanaAccount = getCdpSolanaAddress();
        if (!solanaAccount) throw new Error("Wallet isn't ready yet");
        const { privateKey } = await act(() => exportSolanaAccount({ solanaAccount }));
        detail = { privateKey };
      } catch (e) {
        detail = { error: e instanceof Error ? e.message : "Export failed" };
      }
      window.dispatchEvent(new CustomEvent(CDP_EXPORT_RESULT, { detail }));
    };
    window.addEventListener(CDP_EXPORT_REQUEST, onRequest);
    return () => window.removeEventListener(CDP_EXPORT_REQUEST, onRequest);
  }, [act]);

  // Payments: sign here, inside the provider, and hand the result back out.
  // The signing hook exists only in this tree, so the payment flow asks for a
  // signature by event instead of calling the hook where there is no provider.
  useEffect(() => {
    const onRequest = async (e: Event) => {
      const req = (e as CustomEvent).detail as { id: string; transaction: string };
      let detail: { id: string; signedTransaction?: string; error?: string };
      try {
        const solanaAccount = getCdpSolanaAddress();
        if (!solanaAccount) throw new Error("Wallet isn't ready yet");
        const { signedTransaction } = await act(() => signSolanaTransaction({ solanaAccount, transaction: req.transaction }));
        detail = { id: req.id, signedTransaction };
      } catch (err) {
        detail = { id: req.id, error: err instanceof Error ? err.message : "Signing failed" };
      }
      window.dispatchEvent(new CustomEvent(CDP_SIGN_RESULT, { detail }));
    };
    window.addEventListener(CDP_SIGN_REQUEST, onRequest);
    return () => window.removeEventListener(CDP_SIGN_REQUEST, onRequest);
  }, [act]);

  // 1) our session → CDP session (silent). Right after an email login the
  //    landing leaves a one-shot marker: a locked wallet asks at once then.
  useEffect(() => {
    if (!isAuthed || !isInitialized || isSignedIn) return;
    let askNow = false;
    try {
      askNow = sessionStorage.getItem("enki:wallet-ask") === "1";
      sessionStorage.removeItem("enki:wallet-ask");
    } catch { /* no marker */ }
    signIn()
      .catch(async () => { if (askNow && isCdpLocked()) await unlock(); })
      .catch(() => { /* cancelled or offline: the next wallet action asks again */ });
  }, [isAuthed, isInitialized, isSignedIn, signIn, unlock]);

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
        if (res.ok) setAttached(solanaAddress);
        else attachedFor.current = null; // retry on next change
      } catch {
        attachedFor.current = null;
      }
    })();
  }, [isAuthed, isSignedIn, solanaAddress, evmAddress]);

  return null;
}
