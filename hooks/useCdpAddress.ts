"use client";

/**
 * The user's CDP embedded-wallet Solana address — drop-in replacement for the
 * `address` that useTurnkeyEmailAuth used to provide.
 *
 * Reads lib/cdp-bridge (a module store fed by CdpWalletBridge) rather than the
 * @coinbase/cdp-hooks directly, and that is deliberate: the CDP provider is
 * mounted lazily and only for signed-in users, so calling a CDP hook from the
 * ~20 components that need an address would throw wherever the provider is not
 * mounted. The bridge is plain module state plus a window event, so it is safe
 * to call anywhere, at any time, signed in or not.
 */
import { useEffect, useState } from "react";
import { CDP_ADDRESS_EVENT, getCdpSolanaAddress, getCdpEvmAddress } from "@/lib/cdp-bridge";

export function useCdpAddress(): { address: string | null; evmAddress: string | null } {
  const [address, setAddress] = useState<string | null>(null);
  // The EVM EOA CDP provisions alongside the Solana account (CDP-1,
  // multichain starting point) — informational only, read-only in the UI.
  const [evmAddress, setEvmAddress] = useState<string | null>(null);

  useEffect(() => {
    // Read once on mount — the bridge may already hold an address from an
    // earlier render, in which case no event is coming.
    setAddress(getCdpSolanaAddress());
    setEvmAddress(getCdpEvmAddress());
    const onChange = () => {
      setAddress(getCdpSolanaAddress());
      setEvmAddress(getCdpEvmAddress());
    };
    window.addEventListener(CDP_ADDRESS_EVENT, onChange);
    return () => window.removeEventListener(CDP_ADDRESS_EVENT, onChange);
  }, []);

  return { address, evmAddress };
}
