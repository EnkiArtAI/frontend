"use client";

/**
 * CDP embedded-wallet signer for Solana — the replacement for
 * useTurnkeySolanaSigner.
 *
 * Why this exists: Turnkey signs the BUYER's transaction *server-side*
 * (/api/turnkey/sign-transaction, and the intent path in
 * /api/payments/generation/pay). That is custodial — a key our server controls
 * can move a user's funds. Here the server never sees a buyer signature: the
 * transaction goes from the browser to the user's own wallet and back.
 *
 * ── On "permissionless" ────────────────────────────────────────────────────
 * This is NOT permissionless. Signing is an API call to Coinbase: the key lives
 * in their TEE, and they can suspend the project or a user. It is a large
 * improvement over server-side signing (Enki can no longer sign alone), but the
 * censorship-resistant version is local signing with a client-held key — see
 * the self-custody work. This module is written so that a `local` signer can
 * slot in beside it under the same interface, which is also how additional
 * networks will be added later.
 *
 * ── Why this goes through lib/cdp-bridge ──────────────────────────────────
 * It must NOT call @coinbase/cdp-hooks directly. The CDP provider is mounted
 * lazily and only for signed-in users, while this hook is reached from the
 * editor, which renders whether or not that provider exists — calling a CDP
 * hook there throws "useCDP must be used within a CDPHooksProvider" and takes
 * the whole editor down. The bridge is plain module state plus window events,
 * so it is safe to call anywhere; the actual signing happens in
 * CdpWalletBridge, which does live inside the provider.
 */
import { useCallback, useMemo } from "react";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { requestCdpSign } from "@/lib/cdp-bridge";
import { useCdpAddress } from "@/hooks/useCdpAddress";

export interface CdpSolanaSigner {
  isAvailable: boolean;
  publicKey: PublicKey | null;
  walletAddress: string | null;
  signTransaction: <T extends VersionedTransaction>(tx: T) => Promise<T>;
}

/** base64 without Buffer — this runs in the browser. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function useCdpSolanaSigner(): CdpSolanaSigner {
  // An address is only ever published while the CDP runtime is mounted and
  // signed in, so its presence is the availability signal — no separate
  // isSignedIn read (which would need the provider) is necessary.
  const { address: solanaAddress } = useCdpAddress();

  const publicKey = useMemo(() => {
    if (!solanaAddress) return null;
    try {
      return new PublicKey(solanaAddress);
    } catch {
      return null;
    }
  }, [solanaAddress]);

  const signTransaction = useCallback(
    async <T extends VersionedTransaction>(tx: T): Promise<T> => {
      if (!solanaAddress) throw new Error("CDP wallet not available");

      // The whole transaction goes over, not just the message: our fee payer has
      // already partial-signed it (it fronts gas and ATA rent so buyers need no
      // SOL), and that signature must survive the round trip. Verified in the
      // shipped SDK — cdp-core forwards `transaction` verbatim to the API and
      // does not deserialise or rebuild it, so foreign partial signatures are
      // not dropped the way some peer SDKs drop them.
      const signedB64 = await requestCdpSign(toBase64(tx.serialize()));

      const signed = VersionedTransaction.deserialize(fromBase64(signedB64));

      // Fail loudly rather than broadcasting a transaction that lost the fee
      // payer's signature — a half-signed tx would be rejected on-chain with a
      // far less obvious error.
      const expected = tx.signatures.length;
      if (signed.signatures.length < expected) {
        throw new Error("CDP returned fewer signatures than were sent");
      }
      return signed as T;
    },
    [solanaAddress],
  );

  return {
    isAvailable: Boolean(solanaAddress),
    publicKey,
    walletAddress: solanaAddress ?? null,
    signTransaction,
  };
}
