import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { ChainKey } from "@/shared/payment-config";

export const EMPTY_RECIPIENT = address("11111111111111111111111111111111");
export type EscrowCluster = Extract<ChainKey, "solana-devnet" | "solana">;

/** Match the program's compile-time mint; arbitrary mints are never accepted. */
export function escrowMint(cluster: EscrowCluster): Address {
  switch (cluster) {
    case "solana-devnet": return address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    case "solana": return address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    default: throw new Error("The payment network is unsupported.");
  }
}

/** UUID bytes follow the displayed hex order, not Microsoft GUID byte order. */
export function escrowIntentBytes(intentId: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(intentId)) {
    throw new Error("The payment identifier is invalid.");
  }
  return Uint8Array.from(Buffer.from(intentId.replaceAll("-", ""), "hex"));
}

export async function escrowAddresses(programAddress: Address, buyer: Address, intentId: string) {
  const intentBytes = escrowIntentBytes(intentId);
  const encoder = getAddressEncoder();
  const [config, configBump] = await getProgramDerivedAddress({
    programAddress, seeds: ["config"],
  });
  const [escrow, escrowBump] = await getProgramDerivedAddress({
    programAddress, seeds: ["escrow", encoder.encode(buyer), intentBytes],
  });
  const [vault, vaultBump] = await getProgramDerivedAddress({
    programAddress, seeds: ["vault", encoder.encode(escrow)],
  });
  return { config, configBump, escrow, escrowBump, vault, vaultBump, intentBytes };
}

export async function escrowTokenAddress(owner: Address, mint: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
}
