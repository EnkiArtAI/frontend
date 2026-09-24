/**
 * The pure half of "Send USDC" (components/settings/SendUsdcPanel): amounts,
 * addresses, explorer links and the sentences the server's answers turn into.
 *
 * Money is integer micro-USDC end to end. The amount field is parsed from
 * its DIGITS, never through a float: "1,5" and "1.5" are both 1500000, and a
 * seventh decimal is a refusal rather than a rounding.
 */
import { PublicKey } from "@solana/web3.js";
import { PAYMENT_CHAINS, isChainKey, isSolanaChain } from "@/shared/payment-config";

export const USDC_DECIMALS = 6;

/** "1,5" | "1.5" | "12" | ".5" → integer micro-USDC; null for anything else or zero. */
export function parseUsdcAmount(input: string): number | null {
  const m = /^\s*(\d*)(?:[.,](\d{1,6}))?\s*$/.exec(input);
  if (!m || (!m[1] && !m[2])) return null;
  const micro = Number((m[1] || "0") + (m[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  return Number.isSafeInteger(micro) && micro > 0 ? micro : null;
}

/** Integer micro-USDC → "1.50" (two decimals, more only when they carry value). */
export function formatMicro(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const frac = String(micro % 1_000_000).padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

/** A base58 ed25519 public key, the same test the server applies. */
export function isSolanaAddress(value: string): boolean {
  try {
    return PublicKey.isOnCurve(new PublicKey(value.trim()).toBytes());
  } catch {
    return false;
  }
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

/** Transaction page on the explorer of the chain the server settled on; null for an unknown chain. */
export function explorerTxUrl(chain: unknown, signature: string): string | null {
  if (!isChainKey(chain) || !isSolanaChain(chain)) return null;
  const url = new URL(PAYMENT_CHAINS[chain].explorer);
  url.pathname = `/tx/${signature}`;
  return url.toString();
}

export type WithdrawFailure = { status: number; body: { error?: unknown; code?: unknown } | null };

/**
 * One honest sentence per server answer. Only our own route's `error` string
 * ever reaches the screen; a body that is not ours falls back to the generic
 * line, so a proxy page or a stack can never be shown.
 */
export function withdrawErrorMessage(f: WithdrawFailure, fallback: string): string {
  const code = f.body?.code;
  const serverText = typeof f.body?.error === "string" ? f.body.error : null;
  if (code === "INSUFFICIENT_FUNDS") return "This wallet does not hold that much USDC.";
  if (code === "RATE_LIMITED") return "You have reached the hourly limit for sends, try again later.";
  if (code === "NO_RECIPIENT_ACCOUNT") return "That wallet has never held USDC. It needs to receive USDC from an exchange or another wallet first.";
  if (code === "FROM_MISMATCH") return "The signed in wallet is not the one shown here, reload and try again.";
  if (code === "EXPIRED") return "Signing took too long, start again.";
  if (code === "WITHDRAWALS_NOT_MIGRATED") return serverText ?? fallback;
  if (f.status === 401) return "Your session has ended, sign in again to send.";
  return serverText ?? fallback;
}

/** What the user sees when their wallet refuses or fails to sign. */
export function signingErrorMessage(e: unknown): string {
  return e instanceof Error && /reject|denied|cancel/i.test(e.message)
    ? "Signing was cancelled, nothing moved."
    : "The wallet could not sign, nothing moved.";
}

/** Base64 → bytes without Buffer; this runs in the browser. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
