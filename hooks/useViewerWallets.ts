"use client";

import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useSolanaAuth } from "@/hooks/useSolanaAuth";

/**
 * The viewer's two addresses, which are not the same thing.
 * - userKey keys /api/generations: the signed-in account's address first.
 *   The Solana adapter does not reconnect on a reload (autoConnect off), so
 *   a wallet account's adapter address is gone until the next signing while
 *   its session lives on; keyed by the adapter alone, the History rail read
 *   nothing for it (Kev, 2026-10-13). Then the connected wallets, as before.
 * - payer is the address that pays and holds the balance: the first Solana
 *   address (CDP, then the signed-in wallet, then the adapter). An EVM
 *   address always reads $0.00 from /api/billing/balance, so never one.
 */
export function useViewerWallets(): { userKey: string | null; payer: string | null } {
  const account = useActiveAccount();
  const { publicKey } = useWallet();
  const { address: cdpAddress } = useCdpAddress();
  const { isAuthenticated: signedIn, walletAddress: signInAddress } = useSolanaAuth();
  const adapterAddress = publicKey?.toBase58() ?? null;
  return {
    userKey: (signedIn ? signInAddress : null) ?? account?.address ?? adapterAddress ?? cdpAddress ?? null,
    payer: [cdpAddress, signedIn ? signInAddress : null, adapterAddress].find((a) => a && !a.startsWith("0x")) ?? null,
  };
}
