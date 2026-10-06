import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { solanaConnection, usdcMint } from "@/lib/payments/solana";

/**
 * On-chain USDC balance for a Solana wallet, in USD (USDC is 1:1 to the dollar,
 * which is why every display formats it as $ and never as "USDC").
 *
 * Non-custodial source of truth: reads the wallet's own USDC token account —
 * Enki holds nothing and no longer keeps a ledger of what it owes anyone.
 * Returns 0 when the token account doesn't exist yet or the address is invalid,
 * because "no account" and "empty account" are the same thing to a user.
 *
 * Chain, mint and RPC are the payment rail's own (lib/payments/solana), so a
 * balance is always read on the chain payments settle on. This file used to
 * resolve them itself and applied SOLANA_RPC_URL on every chain: a mainnet
 * URL in a devnet deployment's env then read every balance as $0.
 */
export async function getUsdcBalance(walletAddress: string): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(usdcMint(), new PublicKey(walletAddress));
    const res = await solanaConnection().getTokenAccountBalance(ata);
    return res.value.uiAmount ?? 0;
  } catch {
    return 0;
  }
}
