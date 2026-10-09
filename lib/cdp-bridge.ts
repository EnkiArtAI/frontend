/**
 * Tiny bridge between the standalone CDP runtime tree (CdpWalletBridge, which
 * owns the @coinbase/cdp-hooks context) and the rest of the app, which mounts
 * outside that provider. Addresses flow out via a module store + event.
 * Signing is request/response over window events. Key EXPORT is different
 * again (CDP-1): the key never passes through this module, or through any
 * app JS, at all — a caller hands over a DOM node via
 * setExportIframeContainer, CdpWalletBridge portals CDP's own secure iframe
 * button into it (useSolanaKeyExportIframe), and the button copies the key
 * straight to the clipboard inside that iframe. Only the iframe's status
 * (idle/loading/success/error) relays back, via setExportIframeStatus.
 */
import { sessionAuthHeaders } from "@/lib/session-headers";

export const CDP_ADDRESS_EVENT = "enki-cdp-address";
export const CDP_SIGN_REQUEST = "enki-cdp-sign-request";
export const CDP_SIGN_RESULT = "enki-cdp-sign-result";
export const CDP_EXPORT_IFRAME_EVENT = "enki-cdp-export-iframe";

let solanaAddress: string | null = null;
let evmAddress: string | null = null;

/* The wallet unlock (Kev, 2026-10-07). Once an account has a second factor,
   CDP may act only for a session that passed a wallet step-up: the JWT route
   answers 403 { locked } otherwise. Its last answer is recorded here. The
   runtime registers how to get past the lock; a wallet action awaits
   ensureCdpWallet() before it starts, so no timeout runs while the user
   answers the dialog. */
let locked = false;
// Why the server keeps the wallet closed until the user acts elsewhere (an
// email to confirm), in its own words; no dialog opens it.
let closed: string | null = null;
type Ensure = (opts?: { attached?: boolean }) => Promise<void>;
let ensure: Ensure | null = null;

/** Our JWT for CDP, or undefined; records whether the wallet is locked. CDP
    asks for it before every request, the bridge before every wallet action. */
export async function fetchWalletJwt(): Promise<string | undefined> {
  const res = await fetch("/api/auth/wallet/jwt", { method: "POST", headers: sessionAuthHeaders() });
  const body = (await res.json().catch(() => ({}))) as { jwt?: string; locked?: boolean; confirmEmail?: boolean; error?: string };
  locked = res.status === 403 && body.locked === true;
  closed = res.status === 403 && body.confirmEmail === true ? body.error ?? "Confirm your email to open your wallet." : null;
  return res.ok ? body.jwt : undefined;
}

export function cdpClosedReason(): string | null {
  return closed;
}

export function isCdpLocked(): boolean {
  return locked;
}

export function registerCdpEnsure(fn: Ensure | null) {
  ensure = fn;
}

/** Resolves once the embedded wallet can act: at once without a CDP runtime
    (wallet logins, guests), after the unlock dialog when it is locked; with
    attached, once its address is on our session too (a paid generation).
    Rejects when the user cancels. */
export function ensureCdpWallet(opts?: { attached?: boolean }): Promise<void> {
  return ensure ? ensure(opts) : Promise.resolve();
}

/* The last address per email: CDP forgets it while the wallet is locked, and
   every wallet screen needs it to offer the action that unlocks. Public data,
   cleared on logout. */
const ADDRESS_KEY = "enki-cdp-address:";

export function rememberCdpAddress(email: string, address: string) {
  try { localStorage.setItem(ADDRESS_KEY + email, address); } catch { /* storage off: no memory */ }
}

export function rememberedCdpAddress(email: string): string | null {
  try { return localStorage.getItem(ADDRESS_KEY + email); } catch { return null; }
}

export function forgetCdpAddresses() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith(ADDRESS_KEY)).forEach((k) => localStorage.removeItem(k));
  } catch { /* nothing stored */ }
}

export function setCdpSolanaAddress(addr: string | null) {
  solanaAddress = addr;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CDP_ADDRESS_EVENT));
}

export function getCdpSolanaAddress(): string | null {
  return solanaAddress;
}

/** The signed-in account's EVM address — informational only here (CDP
    wallets are Solana-primary); same store/event pattern as the Solana one. */
export function setCdpEvmAddress(addr: string | null) {
  evmAddress = addr;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CDP_ADDRESS_EVENT));
}

export function getCdpEvmAddress(): string | null {
  return evmAddress;
}

/**
 * Key export (CDP-1): a caller outside the provider (KeyExport.tsx) hands
 * over the DOM node that should host CDP's secure export button.
 * CdpWalletBridge watches this and portals the iframe hook into it once an
 * address is signed in; null unregisters (the dialog closed). The container
 * is plain DOM state — no key material ever passes through this module.
 */
let exportContainer: HTMLElement | null = null;
let exportStatus: { status: string | null; message?: string } = { status: null };

export function setExportIframeContainer(container: HTMLElement | null) {
  exportContainer = container;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CDP_EXPORT_IFRAME_EVENT));
}

export function getExportIframeContainer(): HTMLElement | null {
  return exportContainer;
}

/** CdpWalletBridge publishes the iframe's live status here so the caller's
    UI (a "preparing…"/error line) can reflect it without importing
    @coinbase/cdp-hooks itself. */
export function setExportIframeStatus(status: string | null, message?: string) {
  exportStatus = { status, message };
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CDP_EXPORT_IFRAME_EVENT));
}

export function getExportIframeStatus(): { status: string | null; message?: string } {
  return exportStatus;
}

let signSeq = 0;

/**
 * Ask the CDP runtime to sign a serialized Solana transaction (base64 in,
 * base64 out). Same request/response shape as the export above, for the same
 * reason: the signing hook only exists inside the lazily-mounted provider.
 */
export async function requestCdpSign(transaction: string, timeoutMs = 60_000): Promise<string> {
  await ensureCdpWallet();
  const id = String(++signSeq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("The wallet didn't answer. Reload and try again."));
    }, timeoutMs);
    const onResult = (e: Event) => {
      const d = (e as CustomEvent).detail as
        | { id?: string; signedTransaction?: string; error?: string }
        | undefined;
      // Two signings can overlap (a payment while another is still open).
      // Ignore answers meant for a different request rather than settling one
      // payment with the other's signature.
      if (!d || d.id !== id) return;
      cleanup();
      if (d.signedTransaction) resolve(d.signedTransaction);
      else reject(new Error(d.error || "Signing failed"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener(CDP_SIGN_RESULT, onResult);
    };
    window.addEventListener(CDP_SIGN_RESULT, onResult);
    window.dispatchEvent(new CustomEvent(CDP_SIGN_REQUEST, { detail: { id, transaction } }));
  });
}
