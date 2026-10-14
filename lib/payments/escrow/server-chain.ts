import {
  address, createKeyPairFromBytes, createSolanaRpc, signature,
  type Address, type Base64EncodedWireTransaction, type BlockhashLifetimeConstraint,
} from "@solana/kit";
import { feePayerKeypair, solanaRpcUrls } from "../solana";
import type { EscrowCluster } from "./addresses";
import type { EscrowChainAccount } from "./confirmation";

export class EscrowPaymentError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface EscrowBank {
  slot: bigint;
  chainNowSeconds: number;
  accounts: Array<EscrowChainAccount | null>;
}
export interface EscrowReceipt {
  slot: bigint;
  commitment: "processed" | "confirmed" | "finalized" | null;
  failed: boolean;
}
export interface EscrowChain {
  programAddress: Address;
  cluster: EscrowCluster;
  operatorAddress: Address;
  operatorKeyPair(): Promise<CryptoKeyPair>;
  accounts(addresses: Address[], commitment: "confirmed" | "finalized", minimumSlot?: bigint): Promise<EscrowBank>;
  lifetime(): Promise<BlockhashLifetimeConstraint>;
  height(commitment: "confirmed" | "finalized", minimumSlot?: bigint): Promise<bigint>;
  finalizedHeight(bankSlot: bigint): Promise<bigint>;
  receipt(transactionSignature: string): Promise<EscrowReceipt | null>;
  broadcast(wire: string): Promise<string>;
}

export const ESCROW_CLOCK_ADDRESS = address("SysvarC1ock11111111111111111111111111111111");
const SYSVAR_OWNER = address("Sysvar1111111111111111111111111111111111111");
const GENESIS: Record<EscrowCluster, string> = {
  "solana": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  "solana-devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

/** Clock's five 64-bit fields use Solana's fixed little-endian sysvar layout. */
export function escrowClock(account: EscrowChainAccount | null, bankSlot: bigint): number {
  if (!account || account.address !== ESCROW_CLOCK_ADDRESS || account.programAddress !== SYSVAR_OWNER ||
      account.executable || account.data.length !== 40) {
    throw new EscrowPaymentError(503, "The payment network time is unavailable.");
  }
  const bytes = Buffer.from(account.data);
  const seconds = bytes.readBigInt64LE(32);
  if (bytes.readBigUInt64LE(0) !== bankSlot || seconds < BigInt(0) || seconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EscrowPaymentError(503, "The payment network time is invalid.");
  }
  return Number(seconds);
}

/** Kit owns all new RPC/transaction code; the legacy key loader stays at this boundary. */
export function escrowServerChain(): EscrowChain {
  const cluster = process.env.SOLANA_PAYMENT_CHAIN || process.env.SOLANA_FUND_CHAIN;
  if (cluster !== "solana" && cluster !== "solana-devnet") {
    throw new EscrowPaymentError(503, "The payment network is not configured.");
  }
  let programAddress: Address;
  try { programAddress = address(process.env.SOLANA_ESCROW_PROGRAM_ID ?? ""); }
  catch { throw new EscrowPaymentError(503, "The payment program is not configured."); }
  let operator: ReturnType<typeof feePayerKeypair>;
  try { operator = feePayerKeypair(); }
  catch { throw new EscrowPaymentError(503, "The payment sponsor is unavailable."); }
  const rpcs = solanaRpcUrls().map(url => createSolanaRpc(url));
  const checked = new Set<(typeof rpcs)[number]>();
  const call = async <T>(request: (rpc: (typeof rpcs)[number], abortSignal: AbortSignal) => Promise<T>): Promise<T> => {
    for (const rpc of rpcs) {
      const abortSignal = AbortSignal.timeout(8_000);
      try {
        if (!checked.has(rpc)) {
          if (await rpc.getGenesisHash().send({ abortSignal }) !== GENESIS[cluster]) continue;
          checked.add(rpc);
        }
        return await request(rpc, abortSignal);
      } catch { /* RPC errors may contain provider credentials. Never log or expose them. */ }
    }
    throw new EscrowPaymentError(503, "The payment network is temporarily unavailable.");
  };
  return {
    programAddress, cluster, operatorAddress: address(operator.publicKey.toBase58()),
    operatorKeyPair: () => createKeyPairFromBytes(operator.secretKey),
    async accounts(addresses, commitment, minimumSlot) {
      const all = [...addresses, ESCROW_CLOCK_ADDRESS];
      const result = await call((rpc, abortSignal) => rpc.getMultipleAccounts(all, {
        encoding: "base64", commitment, minContextSlot: minimumSlot,
      }).send({ abortSignal }));
      if (result.context.slot < (minimumSlot ?? BigInt(0)) || result.value.length !== all.length) {
        throw new EscrowPaymentError(503, "The payment network returned an incomplete snapshot.");
      }
      const accounts = result.value.map((account, i): EscrowChainAccount | null => account ? {
        address: all[i], programAddress: account.owner, executable: account.executable,
        data: Buffer.from(account.data[0], "base64"),
      } : null);
      return {
        slot: result.context.slot,
        chainNowSeconds: escrowClock(accounts.pop()!, result.context.slot),
        accounts,
      };
    },
    async lifetime() {
      return (await call((rpc, abortSignal) => rpc.getLatestBlockhash({ commitment: "confirmed" }).send({ abortSignal }))).value;
    },
    height: (commitment, minimumSlot) => call((rpc, abortSignal) =>
      rpc.getBlockHeight({ commitment, minContextSlot: minimumSlot }).send({ abortSignal })),
    async finalizedHeight(bankSlot) {
      const block = await call((rpc, abortSignal) => rpc.getBlock(bankSlot, {
        commitment: "finalized", transactionDetails: "none", rewards: false,
      }).send({ abortSignal }));
      if (!block || block.blockHeight === null) {
        throw new EscrowPaymentError(503, "The finalized payment snapshot is unavailable.");
      }
      return block.blockHeight;
    },
    async receipt(transactionSignature) {
      const result = await call((rpc, abortSignal) => rpc.getSignatureStatuses([signature(transactionSignature)], {
        searchTransactionHistory: true,
      }).send({ abortSignal }));
      const value = result.value[0];
      return value ? { slot: value.slot, commitment: value.confirmationStatus, failed: value.err !== null } : null;
    },
    broadcast: wire => call((rpc, abortSignal) => rpc.sendTransaction(wire as Base64EncodedWireTransaction, {
      encoding: "base64", preflightCommitment: "confirmed", skipPreflight: false, maxRetries: BigInt(2),
    }).send({ abortSignal })),
  };
}
