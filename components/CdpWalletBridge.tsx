"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIsInitialized, useSolanaKeyExportIframe } from "@coinbase/cdp-hooks";
import { authenticateWithJWT, getCurrentUser, getCurrentUserSync, isSignedIn, signOut, signSolanaTransaction, type User } from "@coinbase/cdp-core";
import { useStepUp } from "@/components/StepUpProvider";
import { sessionAuthHeaders } from "@/lib/session-headers";
import {
  setCdpSolanaAddress,
  setCdpEvmAddress,
  fetchWalletJwt,
  isCdpLocked,
  cdpClosedReason,
  registerCdpEnsure,
  rememberCdpAddress,
  rememberedCdpAddress,
  getExportIframeContainer,
  setExportIframeStatus,
  CDP_EXPORT_IFRAME_EVENT,
  CDP_SIGN_REQUEST,
  CDP_SIGN_RESULT,
} from "@/lib/cdp-bridge";

/**
 * Renders CDP's own secure export button into whatever DOM node the caller
 * (KeyExport.tsx) registered via setExportIframeContainer. Lives inside this
 * file so the useSolanaKeyExportIframe call stays inside CDPHooksProvider —
 * the same reason signing and the address read do. The private key never
 * reaches this component: the iframe copies it straight to the clipboard.
 */
function ExportIframeHost({ address }: { address: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { status, message } = useSolanaKeyExportIframe({
    address,
    containerRef,
    label: "Copy private key",
    copiedLabel: "Copied",
  });
  useEffect(() => {
    setExportIframeStatus(status ?? null, message);
  }, [status, message]);
  return <div ref={containerRef} />;
}

/**
 * Bridges our email+password session to CDP. Renders nothing — provisions the
 * wallet invisibly (no connect step the user notices):
 *
 *  1. Each mount signs in to CDP itself (authenticateWithJWT, with our JWT via
 *     the provider's customAuth.getJwt) and trusts only the address of that
 *     sign-in. CDP keeps its user and wallet secret in memory for the page's
 *     lifetime, across our unmounts: after a logout and another account's
 *     login in a second tab it still holds the first account (or receives a
 *     late answer for it), whose wallet must never reach the second one's
 *     session. So any other user CDP holds is signed out before a sign-in,
 *     only this mount's address is published, attached and signed for, and a
 *     call that outlives its mount stops. The runtime is keyed by account.
 *  2. The address is published to the app, remembered for this email, and
 *     attached to our session (auth_sessions + user_wallets).
 *  3. Before every wallet action the JWT route decides (Kev, 2026-10-07): it
 *     answers 403 { locked } once the account has a second factor and this
 *     session's unlock ran out. Only then is the user asked, and no action's
 *     timeout runs meanwhile. Right after an email login (a one-shot marker
 *     from the landing) it asks at once; without a factor never.
 *
 * Sign uses the core function: it reads CDP's state when called, where the
 * hook version keeps the state of the render that created it. Export is
 * different (CDP-1): the key never passes through this component's JS at
 * all — see ExportIframeHost above.
 */
const solanaOf = (user: User | null | undefined) => user?.solanaAccountObjects?.[0]?.address;

export function CdpWalletBridge({ email }: { email: string }) {
  const { isInitialized } = useIsInitialized();
  const { tokenFor } = useStepUp();
  const signingIn = useRef<Promise<string> | null>(null);
  const alive = useRef(true);
  const own = useRef<string | null>(null); // the address this mount signed in
  const [mine, setMine] = useState<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  // A call that outlives its mount (another account's login remounted the
  // runtime meanwhile) must not touch this session or CDP any more.
  const live = useCallback(() => {
    if (!alive.current) throw new Error("The account changed. Try again.");
  }, []);

  // One CDP sign-in at a time; resolves with this account's Solana address.
  // A user CDP holds that is not this mount's own is signed out first, its
  // wallet secret with it; this mount's own stays, an action may be using it.
  const signIn = useCallback(
    () => (signingIn.current ??= (async () => {
      const held = await getCurrentUser(); // with or without a Solana account yet
      if (held && solanaOf(held) !== own.current) await signOut().catch(() => { /* already gone */ });
      const { user } = await authenticateWithJWT();
      live();
      const address = solanaOf(user);
      if (!address) throw new Error("The wallet isn't ready yet. Try again.");
      rememberCdpAddress(email, address);
      own.current = address;
      setMine(address);
      return address;
    })().finally(() => { signingIn.current = null; })),
    [email, live],
  );

  // Writes the address into our session; a paid generation needs it there.
  // Nothing is awaited before the request, so it goes with the session the
  // caller checked.
  const attach = useCallback(async (solana: string) => {
    const evm = getCurrentUserSync()?.evmAccountObjects?.[0]?.address ?? null;
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
      if (!isCdpLocked()) throw new Error(cdpClosedReason() ?? "The wallet isn't available right now. Try again.");
      if (!(await tokenFor("wallet"))) throw new Error("Not confirmed, nothing was signed.");
    }
    const held = own.current && (await isSignedIn()) ? solanaOf(await getCurrentUser()) : undefined;
    const address = held && held === own.current ? held : await signIn();
    live();
    if (attached) await attach(address);
  }, [live, tokenFor, signIn, attach]);

  useEffect(() => {
    registerCdpEnsure(ensure);
    return () => registerCdpEnsure(null);
  }, [ensure]);

  // Publish the address to the app outside this provider tree (deposit UI):
  // this mount's own, never whoever CDP holds. Until it signed in (or while
  // the wallet is locked) the last one for this email stands in, so the
  // screens can offer the action that unlocks.
  useEffect(() => {
    setCdpSolanaAddress(mine ?? rememberedCdpAddress(email));
    return () => setCdpSolanaAddress(null);
  }, [mine, email]);

  // This mount's own wallet → our session.
  useEffect(() => {
    if (mine) attach(mine).catch(() => { /* a paid generation attaches again */ });
  }, [mine, attach]);

  // The silent sign-in, once per mount (its callbacks never change). Right
  // after an email login the landing leaves a one-shot marker: a locked
  // wallet asks at once then.
  useEffect(() => {
    if (!isInitialized) return;
    let askNow = false;
    try {
      askNow = sessionStorage.getItem("enki:wallet-ask") === "1";
      sessionStorage.removeItem("enki:wallet-ask");
    } catch { /* no marker */ }
    (askNow ? ensure() : signIn()).catch(() => { /* locked, cancelled or offline: the next wallet action asks */ });
  }, [isInitialized, ensure, signIn]);

  // Publish the EVM address too (multichain starting point, CDP-1): same
  // mount, same lifetime as the Solana one, informational-only for now.
  useEffect(() => {
    setCdpEvmAddress(mine ? getCurrentUserSync()?.evmAccountObjects?.[0]?.address ?? null : null);
    return () => setCdpEvmAddress(null);
  }, [mine]);

  // Self-custody export (CDP-1): watch for a container a caller outside this
  // provider (KeyExport.tsx) registered, and portal CDP's own secure export
  // button into it once this mount has signed in. Only this mount's address
  // is ever handed to the iframe — CDP refuses export for any other account.
  const [exportContainer, setExportContainerState] = useState<HTMLElement | null>(getExportIframeContainer());
  useEffect(() => {
    const onChange = () => setExportContainerState(getExportIframeContainer());
    window.addEventListener(CDP_EXPORT_IFRAME_EVENT, onChange);
    return () => window.removeEventListener(CDP_EXPORT_IFRAME_EVENT, onChange);
  }, []);

  // Payments: sign here, inside the provider, and hand the result back out.
  // The signing hook exists only in this tree, so the payment flow asks for a
  // signature by event instead of calling the hook where there is no provider.
  useEffect(() => {
    const onRequest = async (e: Event) => {
      const req = (e as CustomEvent).detail as { id: string; transaction: string };
      let detail: { id: string; signedTransaction?: string; error?: string };
      try {
        const solanaAccount = own.current;
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

  return exportContainer && mine ? createPortal(<ExportIframeHost address={mine} />, exportContainer) : null;
}
