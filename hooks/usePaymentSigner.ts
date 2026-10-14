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

/** The required signer that is not the fee payer: the buyer. The escrow
 *  deposit arrives with BOTH slots empty (the operator co-signs after the
 *  buyer), so "the first unsigned slot" would name the operator. */
export function buyerOf(transaction: string): string | null {
  const tx = Transaction.from(fromBase64(transaction));
  const feePayer = tx.feePayer?.toBase58();
  return tx.signatures.find((s) => !s.signature && s.publicKey.toBase58() !== feePayer)?.publicKey.toBase58() ?? null;
}

export async function signForBuyer(
  transaction: string,
  { adapter, cdpAddress }: { adapter: Adapter | null; cdpAddress: string | null },
): Promise<string> {
  const buyer = buyerOf(transaction);
  if (buyer && buyer === cdpAddress) return requestCdpSign(transaction);

  if (buyer && adapter) {
    // autoConnect is off (see SolanaWalletProvider), so after a reload the
    // chosen wallet is remembered but not connected yet. Connect FIRST: a
    // Wallet Standard adapter (Phantom, Solflare, Backpack) has signTransaction
    // only while an account is connected, so looking for it before connecting
    // refused every external wallet after a reload, without ever asking it
    // (Kev's first browser payment, 2026-10-13).
    if (!adapter.connected) await adapter.connect();
    if (adapter.publicKey?.toBase58() === buyer && "signTransaction" in adapter && adapter.signTransaction) {
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
