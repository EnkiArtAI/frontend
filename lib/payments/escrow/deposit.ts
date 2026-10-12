import {
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressFromPublicKey,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
  type Address,
  type BlockhashLifetimeConstraint,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { escrowAmounts, validateEscrowExpiry } from "../escrow-amounts";
import { EMPTY_RECIPIENT, escrowAddresses, escrowMint, escrowTokenAddress, type EscrowCluster } from "./addresses";
import { getDepositInstruction } from "./generated";

export const ESCROW_MAX_PRIORITY_MICROLAMPORTS = 50_000;
export const ESCROW_DEPOSIT_COMPUTE_UNITS = 100_000;

/** All values come from the stored server quote and chain RPC, never the buyer. */
export interface EscrowPaymentSnapshot {
  programAddress: Address;
  cluster: EscrowCluster;
  intentId: string;
  buyer: Address;
  rentPayer: Address;
  treasuryOwner: Address;
  artistOwner: Address;
  units: number;
  treasuryUnitMicro: number;
  artistUnitMicro: number;
  chainNowSeconds: number;
  expiresAtSeconds: number;
}

export interface EscrowDepositPlan extends EscrowPaymentSnapshot {
  /** Required value read from the verified current on-chain Config account. */
  maxDepositMicro: number;
}

/** Persist this message and lifetime before returning the unsigned wire to a wallet. */
export interface PreparedEscrowDeposit {
  unsignedTransactionBase64: string;
  messageBase64: string;
  buyer: Address;
  rentPayer: Address;
  escrowAddress: Address;
  vaultAddress: Address;
  blockhash: string;
  lastValidBlockHeight: string;
  depositedMicro: number;
}

/** Validate immutable funded fields without consulting today's deposit policy. */
export function validateEscrowPaymentSnapshot(plan: EscrowPaymentSnapshot) {
  const fundedTotal = plan.units * (plan.treasuryUnitMicro + plan.artistUnitMicro);
  // This bound is the snapshot's own amount, not a policy limit or fallback cap.
  const amounts = escrowAmounts(plan.units, plan.treasuryUnitMicro, plan.artistUnitMicro, fundedTotal);
  validateEscrowExpiry(plan.chainNowSeconds, plan.expiresAtSeconds);
  escrowMint(plan.cluster);
  if (plan.buyer === plan.rentPayer || plan.treasuryOwner === EMPTY_RECIPIENT ||
      (plan.artistUnitMicro === 0) !== (plan.artistOwner === EMPTY_RECIPIENT)) {
    throw new Error("The payment recipients or payer are invalid.");
  }
  return amounts;
}

export function validateEscrowDepositPlan(plan: EscrowDepositPlan): void {
  validateEscrowPaymentSnapshot(plan);
  escrowAmounts(plan.units, plan.treasuryUnitMicro, plan.artistUnitMicro, plan.maxDepositMicro);
}

export async function prepareEscrowDeposit(
  plan: EscrowDepositPlan,
  lifetime: BlockhashLifetimeConstraint,
  priorityMicroLamports = 0,
): Promise<PreparedEscrowDeposit> {
  validateEscrowDepositPlan(plan);
  if (!Number.isSafeInteger(priorityMicroLamports) || priorityMicroLamports < 0 ||
      priorityMicroLamports > ESCROW_MAX_PRIORITY_MICROLAMPORTS || lifetime.lastValidBlockHeight < BigInt(0)) {
    throw new Error("The payment transaction limits are invalid.");
  }
  const derived = await escrowAddresses(plan.programAddress, plan.buyer, plan.intentId);
  const mint = escrowMint(plan.cluster);
  const deposit = getDepositInstruction({
    config: derived.config,
    buyer: createNoopSigner(plan.buyer),
    rentPayer: createNoopSigner(plan.rentPayer),
    mint,
    buyerAta: await escrowTokenAddress(plan.buyer, mint),
    escrow: derived.escrow,
    vault: derived.vault,
    intentId: derived.intentBytes,
    units: plan.units,
    recipientOwners: [plan.treasuryOwner, plan.artistOwner],
    unitAmounts: [plan.treasuryUnitMicro, plan.artistUnitMicro],
    expiresAt: plan.expiresAtSeconds,
  }, { programAddress: plan.programAddress });
  const message = appendTransactionMessageInstructions([
    getSetComputeUnitLimitInstruction({ units: ESCROW_DEPOSIT_COMPUTE_UNITS }),
    getSetComputeUnitPriceInstruction({ microLamports: priorityMicroLamports }),
    deposit,
  ], setTransactionMessageLifetimeUsingBlockhash(lifetime,
    setTransactionMessageFeePayer(plan.rentPayer, createTransactionMessage({ version: "legacy" }))));
  const transaction = compileTransaction(message);
  assertIsTransactionWithinSizeLimit(transaction);
  return {
    unsignedTransactionBase64: Buffer.from(getTransactionEncoder().encode(transaction)).toString("base64"),
    messageBase64: Buffer.from(transaction.messageBytes).toString("base64"),
    buyer: plan.buyer,
    rentPayer: plan.rentPayer,
    escrowAddress: derived.escrow,
    vaultAddress: derived.vault,
    blockhash: lifetime.blockhash,
    lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
    depositedMicro: escrowAmounts(plan.units, plan.treasuryUnitMicro, plan.artistUnitMicro, plan.maxDepositMicro).depositedMicro,
  };
}

function base64Bytes(value: string, maximumBytes: number): Buffer {
  if (value.length === 0 || value.length > 4 * Math.ceil(maximumBytes / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("The signed payment is malformed.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximumBytes || bytes.toString("base64") !== value) {
    throw new Error("The signed payment is malformed.");
  }
  return bytes;
}

/**
 * Before acquiring the route's submission CAS, compare with the ORIGINAL
 * persisted message. Do not rebuild from current prices, debt or blockhash.
 * This function cannot simulate, broadcast, confirm or change database rows.
 */
export async function verifyBuyerEscrowDeposit(
  prepared: Pick<PreparedEscrowDeposit, "messageBase64" | "buyer" | "rentPayer">,
  signedTransactionBase64: string,
) {
  const bytes = base64Bytes(signedTransactionBase64, 1232);
  const transaction = getTransactionDecoder().decode(bytes);
  if (!Buffer.from(getTransactionEncoder().encode(transaction)).equals(bytes)) {
    throw new Error("The signed payment is malformed.");
  }
  if (!Buffer.from(transaction.messageBytes).equals(base64Bytes(prepared.messageBase64, 1232))) {
    throw new Error("The signed payment differs from the prepared payment.");
  }
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const signers = Object.keys(transaction.signatures);
  if (message.version !== "legacy" || signers.length !== 2 || prepared.buyer === prepared.rentPayer ||
      signers[0] !== prepared.rentPayer || signers[1] !== prepared.buyer) {
    throw new Error("The payment signers are invalid.");
  }
  const buyerSignature = transaction.signatures[prepared.buyer];
  if (!buyerSignature || !(await verifySignature(await getPublicKeyFromAddress(prepared.buyer),
    buyerSignature, transaction.messageBytes))) {
    throw new Error("The buyer has not signed this payment.");
  }
  return transaction;
}

/** Only the database submission winner may call this after buyer verification. */
export async function coSignEscrowDeposit(
  prepared: Pick<PreparedEscrowDeposit, "messageBase64" | "buyer" | "rentPayer">,
  signedTransactionBase64: string,
  feePayerKeyPair: CryptoKeyPair,
): Promise<{ signedTransactionBase64: string; depositSignature: string }> {
  const transaction = await verifyBuyerEscrowDeposit(prepared, signedTransactionBase64);
  if (await getAddressFromPublicKey(feePayerKeyPair.publicKey) !== prepared.rentPayer) {
    throw new Error("The payment sponsor is unavailable.");
  }
  // Discard any untrusted sponsor signature; produce it only after buyer verification.
  const signed = await partiallySignTransaction([feePayerKeyPair], {
    ...transaction,
    signatures: { ...transaction.signatures, [prepared.rentPayer]: null },
  });
  assertIsFullySignedTransaction(signed);
  assertIsTransactionWithinSizeLimit(signed);
  return {
    signedTransactionBase64: Buffer.from(getTransactionEncoder().encode(signed)).toString("base64"),
    depositSignature: getSignatureFromTransaction(signed),
  };
}
