"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIsInitialized, useSolanaAddress } from "@coinbase/cdp-hooks";
import { authenticateWithJWT, exportSolanaAccount, getCurrentUser, isSignedIn, signSolanaTransaction } from "@coinbase/cdp-core";
import { useStepUp } from "@/components/StepUpProvider";
import { sessionAuthHeaders } from "@/lib/session-headers";
import {
  setCdpSolanaAddress,
  fetchWalletJwt,
  isCdpLocked,
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
 *  1. Each mount signs in to CDP itself (authenticateWithJWT, with our JWT via
 *     the provider's customAuth.getJwt) and trusts only that sign-in. CDP keeps
 *     its user in memory for the page's lifetime, across our unmounts: after a
 *     logout and another account's login in a second tab it still holds the
 *     first account, whose wallet must never reach the second one's session.
 *     The runtime is keyed by account (providers), so a switch remounts.
 *  2. The address is published to the app, remembered for this email, and
 *     attached to our session (auth_sessions + user_wallets).
 *  3. Before every wallet action the JWT route decides (Kev, 2026-10-07): it
 *     answers 403 { locked } once the account has a second factor and this
 *     session's unlock ran out. Only then is the user asked, and no action's
 *     timeout runs meanwhile. Right after an email login (a one-shot marker
 *     from the landing) it asks at once; without a factor never.
 *
 * Sign and export use the core functions: they read CDP's state when called,
 * where the hook versions keep the state of the render that created them.
 */
export function CdpWalletBridge({ email }: { email: string }) {
  const { isInitialized } = useIsInitialized();
  const { solanaAddress } = useSolanaAddress();
  const { tokenFor } = useStepUp();
  const signingIn = useRef<Promise<string> | null>(null);
  const started = useRef(false);
  const [mine, setMine] = useState(false);

  // One CDP sign-in at a time; resolves with this account's Solana address.
  const signIn = useCallback(
    () => (signingIn.current ??= authenticateWithJWT()
      .then(({ user }) => {
        const address = user.solanaAccountObjects?.[0]?.address;
        if (!address) throw new Error("The wallet isn't ready yet. Try again.");
        rememberCdpAddress(email, address);
        setMine(true);
        return address;
      })
      .finally(() => { signingIn.current = null; })),
    [email],
  );

  // Writes the address into our session; a paid generation needs it there.
  const attach = useCallback(async (solana: string) => {
    const evm = (await getCurrentUser())?.evmAccountObjects?.[0]?.address ?? null;
    const res = await fetch("/api/auth/session/attach-wallet", {
      method: "POST",
      headers: { "content-type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ solanaAddress: solana, evmAddress: evm }),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "Could not link the wallet. Try again.");
  }, []);

  // Resolves once CDP can act for this session: the server first, the dialog
  // only when it still says locked (an export step-up, an unlock in another
  // tab or a removed last factor count at once), then this mount's sign-in.
  const ensure = useCallback(async ({ attached = false } = {}) => {
    if (!(await fetchWalletJwt())) {
      if (!isCdpLocked()) throw new Error("The wallet isn't available right now. Try again.");
      if (!(await tokenFor("wallet"))) throw new Error("Not confirmed, nothing was signed.");
    }
    const user = mine && (await isSignedIn()) ? await getCurrentUser() : null;
    const address = user?.solanaAccountObjects?.[0]?.address ?? (await signIn());
    if (attached) await attach(address);
  }, [mine, tokenFor, signIn, attach]);

  useEffect(() => {
    registerCdpEnsure(ensure);
    return () => registerCdpEnsure(null);
  }, [ensure]);

  // Publish the address to the app outside this provider tree (deposit UI).
  // Until this mount signed in (or while the wallet is locked) the last one
  // for this email stands in, so the screens can offer the action that unlocks.
  useEffect(() => {
    setCdpSolanaAddress((mine && solanaAddress) || rememberedCdpAddress(email));
    return () => setCdpSolanaAddress(null);
  }, [mine, solanaAddress, email]);

  // This mount's own wallet → our session.
  useEffect(() => {
    if (mine && solanaAddress) attach(solanaAddress).catch(() => { /* a paid generation attaches again */ });
  }, [mine, solanaAddress, attach]);

  // The silent sign-in, once per mount. Right after an email login the landing
  // leaves a one-shot marker: a locked wallet asks at once then.
  useEffect(() => {
    if (!isInitialized || started.current) return;
    started.current = true;
    let askNow = false;
    try {
      askNow = sessionStorage.getItem("enki:wallet-ask") === "1";
      sessionStorage.removeItem("enki:wallet-ask");
    } catch { /* no marker */ }
    (askNow ? ensure() : signIn()).catch(() => { /* locked, cancelled or offline: the next wallet action asks */ });
  }, [isInitialized, ensure, signIn]);

  // Self-custody: answer key-export requests (Payment → "Your private key").
  // The requesting side confirms with the second factor and awaits ensure().
  useEffect(() => {
    const onRequest = async () => {
      let detail: { privateKey?: string; error?: string };
      try {
        const solanaAccount = (await getCurrentUser())?.solanaAccountObjects?.[0]?.address;
        if (!solanaAccount) throw new Error("Wallet isn't ready yet");
        const { privateKey } = await exportSolanaAccount({ solanaAccount });
        detail = { privateKey };
      } catch (e) {
        detail = { error: e instanceof Error ? e.message : "Export failed" };
      }
      window.dispatchEvent(new CustomEvent(CDP_EXPORT_RESULT, { detail }));
    };
    window.addEventListener(CDP_EXPORT_REQUEST, onRequest);
    return () => window.removeEventListener(CDP_EXPORT_REQUEST, onRequest);
  }, []);

  // Payments: sign here, inside the provider, and hand the result back out.
  // The signing hook exists only in this tree, so the payment flow asks for a
  // signature by event instead of calling the hook where there is no provider.
  useEffect(() => {
    const onRequest = async (e: Event) => {
      const req = (e as CustomEvent).detail as { id: string; transaction: string };
      let detail: { id: string; signedTransaction?: string; error?: string };
      try {
        const solanaAccount = (await getCurrentUser())?.solanaAccountObjects?.[0]?.address;
        if (!solanaAccount) throw new Error("Wallet isn't ready yet");
        const { signedTransaction } = await signSolanaTransaction({ solanaAccount, transaction: req.transaction });
        detail = { id: req.id, signedTransaction };
      } catch (err) {
        detail = { id: req.id, error: err instanceof Error ? err.message : "Signing failed" };
      }
      window.dispatchEvent(new CustomEvent(CDP_SIGN_RESULT, { detail }));
    };
    window.addEventListener(CDP_SIGN_REQUEST, onRequest);
    return () => window.removeEventListener(CDP_SIGN_REQUEST, onRequest);
  }, []);

  return null;
}
