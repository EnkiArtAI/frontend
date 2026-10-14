import { isNone, type Address, type ReadonlyUint8Array } from "@solana/kit";
import { AccountState, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  ESCROW_MAX_REFUND_ATA_FEE_MICRO,
  ESCROW_MIN_TTL_SECONDS, ESCROW_MAX_TTL_SECONDS,
} from "../escrow-amounts";
import { EMPTY_RECIPIENT, escrowAddresses, escrowMint } from "./addresses";
import { validateEscrowDepositPlan, validateEscrowPaymentSnapshot, type EscrowPaymentSnapshot } from "./deposit";
import {
  CONFIG_DISCRIMINATOR, ESCROW_DISCRIMINATOR, EscrowState,
  getConfigDecoder, getEscrowDecoder,
} from "./generated";

export interface EscrowChainAccount {
  address: Address;
  programAddress: Address;
  executable: boolean;
  data: ReadonlyUint8Array;
}

function sameBytes(left: ReadonlyUint8Array | readonly number[], right: ReadonlyUint8Array | readonly number[]) {
  return Buffer.from(left).equals(Buffer.from(right));
}

/** Check the current configuration before preparing a deposit; this performs no RPC. */
export async function validateEscrowConfiguration(plan: EscrowPaymentSnapshot, account: EscrowChainAccount) {
  validateEscrowPaymentSnapshot(plan);
  const derived = await escrowAddresses(plan.programAddress, plan.buyer, plan.intentId);
  if (account.address !== derived.config || account.programAddress !== plan.programAddress ||
      account.executable || account.data.length !== getConfigDecoder().fixedSize) {
    throw new Error("The payment configuration is unavailable.");
  }
  const config = getConfigDecoder().decode(account.data);
  const ttl = BigInt(plan.expiresAtSeconds - plan.chainNowSeconds);
  if (!sameBytes(config.discriminator, CONFIG_DISCRIMINATOR) || config.bump !== derived.configBump ||
      config.admin === EMPTY_RECIPIENT || config.guardian === EMPTY_RECIPIENT ||
      config.operator === EMPTY_RECIPIENT || config.operator !== plan.rentPayer ||
      config.treasuryOwner !== plan.treasuryOwner || config.paused ||
      config.maxDepositMicro <= BigInt(0) || config.maxDepositMicro > BigInt(Number.MAX_SAFE_INTEGER) ||
      config.minTtlS < BigInt(ESCROW_MIN_TTL_SECONDS) || config.maxTtlS > BigInt(ESCROW_MAX_TTL_SECONDS) ||
      config.minTtlS > config.maxTtlS || ttl < config.minTtlS || ttl > config.maxTtlS ||
      config.refundAtaFeeMicro > BigInt(ESCROW_MAX_REFUND_ATA_FEE_MICRO)) {
    throw new Error("The payment configuration does not allow this deposit.");
  }
  // SQL and preparation receive this verified chain value, with no second cap.
  validateEscrowDepositPlan({ ...plan, maxDepositMicro: Number(config.maxDepositMicro) });
  return config;
}

/**
 * Supply the escrow AND vault from one confirmed/finalized getMultipleAccounts
 * response with minContextSlot at least the deposit confirmation's slot.
 * A transaction signature alone never authorizes generation.
 */
export async function verifyFundedEscrow(plan: EscrowPaymentSnapshot, receipt: {
  commitment: "confirmed" | "finalized";
  contextSlot: bigint;
  minimumSlot: bigint;
  chainNowSeconds: number;
  /** Reconciliation only: adopt an expired funded deposit for refund, never for generation. */
  allowExpired?: boolean;
  escrow: EscrowChainAccount;
  vault: EscrowChainAccount;
}) {
  const amount = validateEscrowPaymentSnapshot(plan).depositedMicro;
  if (!["confirmed", "finalized"].includes(receipt.commitment) || receipt.minimumSlot <= BigInt(0) ||
      receipt.contextSlot < receipt.minimumSlot || !Number.isSafeInteger(receipt.chainNowSeconds) ||
      receipt.chainNowSeconds < 0 || (!receipt.allowExpired && receipt.chainNowSeconds >= plan.expiresAtSeconds)) {
    throw new Error("The payment has not been confirmed yet.");
  }
  const derived = await escrowAddresses(plan.programAddress, plan.buyer, plan.intentId);
  const mint = escrowMint(plan.cluster);
  const { escrow: account, vault: vaultAccount } = receipt;
  if (account.address !== derived.escrow || account.programAddress !== plan.programAddress ||
      account.executable || account.data.length !== getEscrowDecoder().fixedSize || vaultAccount.address !== derived.vault ||
      vaultAccount.programAddress !== TOKEN_PROGRAM_ADDRESS || vaultAccount.executable || vaultAccount.data.length !== getTokenDecoder().fixedSize) {
    throw new Error("The confirmed payment accounts are invalid.");
  }
  const escrow = getEscrowDecoder().decode(account.data);
  const vault = getTokenDecoder().decode(vaultAccount.data);
  if (!sameBytes(escrow.discriminator, ESCROW_DISCRIMINATOR) || escrow.version !== 1 ||
      escrow.state !== EscrowState.Funded || escrow.bump !== derived.escrowBump ||
      escrow.vaultBump !== derived.vaultBump || !sameBytes(escrow.intentId, derived.intentBytes) ||
      escrow.buyer !== plan.buyer || escrow.rentPayer !== plan.rentPayer || escrow.mint !== mint ||
      escrow.recipientCount !== (plan.artistUnitMicro > 0 ? 2 : 1) ||
      escrow.recipientOwners[0] !== plan.treasuryOwner || escrow.recipientOwners[1] !== plan.artistOwner ||
      escrow.unitAmounts[0] !== BigInt(plan.treasuryUnitMicro) || escrow.unitAmounts[1] !== BigInt(plan.artistUnitMicro) ||
      escrow.units !== plan.units || escrow.settledUnits !== 0 || escrow.refundDue !== BigInt(amount) ||
      escrow.expiresAt !== BigInt(plan.expiresAtSeconds) ||
      escrow.createdAt < BigInt(0) || escrow.createdAt > BigInt(receipt.chainNowSeconds) ||
      escrow.expiresAt - escrow.createdAt < BigInt(ESCROW_MIN_TTL_SECONDS) ||
      escrow.expiresAt - escrow.createdAt > BigInt(ESCROW_MAX_TTL_SECONDS) ||
      vault.mint !== mint || vault.owner !== derived.escrow || vault.state !== AccountState.Initialized ||
      vault.amount < BigInt(amount) || !isNone(vault.delegate) || !isNone(vault.closeAuthority) || !isNone(vault.isNative)) {
    throw new Error("The confirmed payment does not match the prepared deposit.");
  }
  // Third parties can donate to a vault. Those tokens never increase paid units.
  return { escrow, vault, depositedMicro: amount };
}
