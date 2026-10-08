/**
 * The client half of linking a wallet (/api/wallet/linked): a nonce from the
 * server, the wallet's signature over linkWalletMessage, the server's check.
 * Returns the linked address.
 *
 * It talks to the adapter directly, never through the WalletProvider's
 * select(): the profile and the payment panel read the provider's connected
 * key as the account's wallet, and a linked wallet only shows NFTs. For the
 * same reason a wallet this call connected is disconnected again, whatever
 * happens; one that was connected before stays as it was.
 */
import type { MessageSignerWalletAdapter } from "@solana/wallet-adapter-base";
import { linkWalletMessage } from "@/lib/link-wallet-message";
import { sessionAuthHeaders } from "@/lib/session-headers";

export async function linkWallet(adapter: MessageSignerWalletAdapter, domain = window.location.host): Promise<string> {
  const wasConnected = adapter.connected;
  try {
    if (!wasConnected) await adapter.connect();
    const address = adapter.publicKey?.toBase58();
    if (!address) throw new Error("The wallet did not share its address.");
    const nonceRes = await fetch("/api/auth/nonce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: address, walletType: "solana" }),
    });
    const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string };
    if (!nonceRes.ok || !nonce) throw new Error("Linking could not start. Try again.");
    const signed = await adapter.signMessage(new TextEncoder().encode(linkWalletMessage({ domain, address, nonce })));
    const res = await fetch("/api/wallet/linked", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ address, nonce, signature: btoa(String.fromCharCode(...signed)) }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(body.error || "The wallet could not be linked. Try again.");
    return address;
  } finally {
    if (!wasConnected) await adapter.disconnect().catch(() => { /* already gone */ });
  }
}
