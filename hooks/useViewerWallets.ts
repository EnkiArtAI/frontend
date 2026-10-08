"use client";

import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useSolanaAuth } from "@/hooks/useSolanaAuth";

/**
 * The viewer's two addresses, which are not the same thing.
 * - userKey keys /api/generations; it is PromptGeneratorView's rule, kept
 *   as is so a viewer's history stays theirs.
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
    userKey: account?.address ?? adapterAddress ?? cdpAddress ?? null,
    payer: [cdpAddress, signedIn ? signInAddress : null, adapterAddress].find((a) => a && !a.startsWith("0x")) ?? null,
  };
}
