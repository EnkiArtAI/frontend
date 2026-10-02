"use client";

/**
 * Signs a payment authorisation with the wallet it is FOR.
 *
 * The server builds the transaction for the session's wallet and has already
 * partial-signed it as fee payer, so exactly one signer is missing: the buyer.
 * That address picks the signer. An external wallet (Phantom, Solflare) signs
 * through the wallet adapter; an embedded wallet signs through CDP. Matching
 * on the address rather than on "whichever is connected" matters when both
 * exist: a Phantom left connected must not be asked to sign for a CDP account.
 */
import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import type { Adapter } from "@solana/wallet-adapter-base";
import { requestCdpSign, getCdpSolanaAddress } from "@/lib/cdp-bridge";
import { CheckoutError, type PaymentSigner } from "@/lib/generation-checkout";

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** The one required signer that has not signed yet: the buyer. */
export function buyerOf(transaction: string): string | null {
  return Transaction.from(fromBase64(transaction)).signatures.find((s) => !s.signature)?.publicKey.toBase58() ?? null;
}

export async function signForBuyer(
  transaction: string,
  { adapter, cdpAddress }: { adapter: Adapter | null; cdpAddress: string | null },
): Promise<string> {
  const buyer = buyerOf(transaction);
  if (buyer && buyer === cdpAddress) return requestCdpSign(transaction);

  if (buyer && adapter && "signTransaction" in adapter) {
    // autoConnect is off (see SolanaWalletProvider), so after a reload the
    // chosen wallet is remembered but not connected yet.
    if (!adapter.connected) await adapter.connect();
    if (adapter.publicKey?.toBase58() === buyer) {
      const signed = await adapter.signTransaction(Transaction.from(fromBase64(transaction)));
      return signed.serialize({ requireAllSignatures: false }).toString("base64");
    }
  }
  throw new CheckoutError("sign", "This payment is for the wallet you signed in with. Connect that wallet — nothing was charged.");
}

export function usePaymentSigner(): PaymentSigner {
  const { wallet } = useWallet();
  const adapter = wallet?.adapter ?? null;
  return useCallback(
    (transaction: string) => signForBuyer(transaction, { adapter, cdpAddress: getCdpSolanaAddress() }),
    [adapter],
  );
}
