import {
  appendTransactionMessageInstructions, assertIsFullySignedTransaction, assertIsTransactionWithinSizeLimit,
  compileTransaction, createNoopSigner, createTransactionMessage, getAddressFromPublicKey,
  getSignatureFromTransaction, getTransactionEncoder, partiallySignTransaction, isNone,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type BlockhashLifetimeConstraint, type Instruction,
} from "@solana/kit";
import { AccountState, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { ESCROW_MIN_TTL_SECONDS, ESCROW_MAX_TTL_SECONDS } from "../escrow-amounts";
import { escrowAddresses, escrowMint, escrowTokenAddress } from "./addresses";
import { validateEscrowPaymentSnapshot, type EscrowPaymentSnapshot } from "./deposit";
import type { EscrowChainAccount } from "./confirmation";
import { ESCROW_DISCRIMINATOR, EscrowState, getEscrowDecoder, getSettleInstruction, getReclaimInstruction } from "./generated";

/** Decode immutable identity before trusting either a funded or settled account. */
export async function readEscrowSnapshot(plan: EscrowPaymentSnapshot, account: EscrowChainAccount) {
  validateEscrowPaymentSnapshot(plan);
  const derived = await escrowAddresses(plan.programAddress, plan.buyer, plan.intentId);
  if (account.address !== derived.escrow || account.programAddress !== plan.programAddress || account.executable ||
      account.data.length !== getEscrowDecoder().fixedSize) throw new Error("The payment account is invalid.");
  const escrow = getEscrowDecoder().decode(account.data);
  if (!Buffer.from(escrow.discriminator).equals(Buffer.from(ESCROW_DISCRIMINATOR)) || escrow.version !== 1 ||
      escrow.bump !== derived.escrowBump || escrow.vaultBump !== derived.vaultBump ||
      !Buffer.from(escrow.intentId).equals(Buffer.from(derived.intentBytes)) ||
      escrow.buyer !== plan.buyer || escrow.rentPayer !== plan.rentPayer || escrow.mint !== escrowMint(plan.cluster) ||
      escrow.units !== plan.units || escrow.recipientCount !== (plan.artistUnitMicro > 0 ? 2 : 1) ||
      escrow.recipientOwners[0] !== plan.treasuryOwner || escrow.recipientOwners[1] !== plan.artistOwner ||
      escrow.unitAmounts[0] !== BigInt(plan.treasuryUnitMicro) || escrow.unitAmounts[1] !== BigInt(plan.artistUnitMicro) ||
      escrow.expiresAt !== BigInt(plan.expiresAtSeconds) || escrow.createdAt < BigInt(0) ||
      escrow.expiresAt - escrow.createdAt < BigInt(ESCROW_MIN_TTL_SECONDS) ||
      escrow.expiresAt - escrow.createdAt > BigInt(ESCROW_MAX_TTL_SECONDS)) {
    throw new Error("The payment account differs from its quote.");
  }
  return escrow;
}

export async function verifySettledEscrow(plan: EscrowPaymentSnapshot, k: number, proof: {
  contextSlot: bigint; minimumSlot: bigint; escrow: EscrowChainAccount; vault: EscrowChainAccount;
}) {
  if (proof.minimumSlot <= BigInt(0) || proof.contextSlot < proof.minimumSlot ||
      !Number.isInteger(k) || k < 0 || k > plan.units) throw new Error("The settlement proof is invalid.");
  const escrow = await readEscrowSnapshot(plan, proof.escrow);
  const derived = await escrowAddresses(plan.programAddress, plan.buyer, plan.intentId);
  if (proof.vault.address !== derived.vault || proof.vault.programAddress !== TOKEN_PROGRAM_ADDRESS ||
      proof.vault.executable || proof.vault.data.length !== getTokenDecoder().fixedSize) throw new Error("The payment vault is invalid.");
  const vault = getTokenDecoder().decode(proof.vault.data);
  const total = BigInt(validateEscrowPaymentSnapshot(plan).depositedMicro);
  const treasuryPaid = BigInt(k) * BigInt(plan.treasuryUnitMicro);
  const artistDue = BigInt(k) * BigInt(plan.artistUnitMicro);
  const refundIfArtistPaid = total - treasuryPaid - artistDue;
  const refundIfArtistForfeited = total - treasuryPaid;
  const artistPaid = escrow.refundDue === refundIfArtistPaid ? artistDue : BigInt(0);
  if (escrow.state !== EscrowState.Settled || escrow.settledUnits !== k ||
      (escrow.refundDue !== refundIfArtistPaid && escrow.refundDue !== refundIfArtistForfeited) ||
      vault.owner !== derived.escrow || vault.mint !== escrowMint(plan.cluster) || vault.state !== AccountState.Initialized ||
      vault.amount < escrow.refundDue || !isNone(vault.delegate) || !isNone(vault.closeAuthority) || !isNone(vault.isNative)) {
    throw new Error("The settlement differs from the delivered images.");
  }
  return { escrow, treasuryPaid, artistPaid, refundDue: escrow.refundDue };
}

async function signLifecycleTransaction(instruction: Instruction, signer: CryptoKeyPair, lifetime: BlockhashLifetimeConstraint) {
  if (lifetime.lastValidBlockHeight < BigInt(0)) throw new Error("The payment transaction lifetime is invalid.");
  const payer = await getAddressFromPublicKey(signer.publicKey);
  const message = appendTransactionMessageInstructions([
    getSetComputeUnitLimitInstruction({ units: 120_000 }), instruction,
  ], setTransactionMessageLifetimeUsingBlockhash(lifetime,
    setTransactionMessageFeePayer(payer, createTransactionMessage({ version: "legacy" }))));
  const transaction = await partiallySignTransaction([signer], compileTransaction(message));
  assertIsFullySignedTransaction(transaction); assertIsTransactionWithinSizeLimit(transaction);
  return { signedTransactionBase64: Buffer.from(getTransactionEncoder().encode(transaction)).toString("base64"),
    signature: getSignatureFromTransaction(transaction), blockhash: lifetime.blockhash,
    lastValidBlockHeight: lifetime.lastValidBlockHeight.toString() };
}

/** k is the frozen count read from the service-only batch RPC, never the request. */
export async function prepareEscrowSettlement(plan: EscrowPaymentSnapshot, k: number,
  signer: CryptoKeyPair, lifetime: BlockhashLifetimeConstraint) {
  validateEscrowPaymentSnapshot(plan);
  if (!Number.isInteger(k) || k < 0 || k > plan.units) throw new Error("The delivered image count is invalid.");
  const derived = await escrowAddresses(plan.programAddress, plan.buyer, plan.intentId);
  const mint = escrowMint(plan.cluster);
  const instruction = getSettleInstruction({ config: derived.config,
    operator: createNoopSigner(await getAddressFromPublicKey(signer.publicKey)),
    escrow: derived.escrow, vault: derived.vault, mint,
    treasuryAta: await escrowTokenAddress(plan.treasuryOwner, mint),
    artistAta: await escrowTokenAddress(plan.artistOwner, mint), k,
  }, { programAddress: plan.programAddress });
  // No artist-account lookup, ATA creation or reclaim instruction can prevent this settle.
  return signLifecycleTransaction(instruction, signer, lifetime);
}

/** Reclaim is always its own transaction, after settlement or escrow expiry. */
export async function prepareEscrowReclaim(plan: EscrowPaymentSnapshot, signer: CryptoKeyPair,
  lifetime: BlockhashLifetimeConstraint) {
  validateEscrowPaymentSnapshot(plan);
  const derived = await escrowAddresses(plan.programAddress, plan.buyer, plan.intentId);
  const mint = escrowMint(plan.cluster);
  const instruction = getReclaimInstruction({ caller: createNoopSigner(await getAddressFromPublicKey(signer.publicKey)),
    config: derived.config, rentPayer: plan.rentPayer, buyer: plan.buyer, escrow: derived.escrow, vault: derived.vault, mint,
    buyerAta: await escrowTokenAddress(plan.buyer, mint), treasuryAta: await escrowTokenAddress(plan.treasuryOwner, mint),
  }, { programAddress: plan.programAddress });
  return signLifecycleTransaction(instruction, signer, lifetime);
}
