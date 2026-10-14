/** Amount rules from ClickUp 123qmzqzw1w; no RPC, database or fee calculation. */
export const ESCROW_MAX_UNITS = 24;
export const ESCROW_MAX_REFUND_ATA_FEE_MICRO = 1_000_000;
export const ESCROW_MIN_TTL_SECONDS = 600;
export const ESCROW_MAX_TTL_SECONDS = 1_800;

function micro(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Payment amounts must be non-negative safe integers.");
  }
}

function units(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > ESCROW_MAX_UNITS) {
    throw new Error("The payment has an unsupported image count.");
  }
}

export interface EscrowAmounts {
  units: number;
  treasuryUnitMicro: number;
  artistUnitMicro: number;
  depositedMicro: number;
}

/** Validate immutable deposit arithmetic independently of today's Config cap. */
function checkedAmounts(count: number, treasuryUnitMicro: number, artistUnitMicro: number): EscrowAmounts {
  units(count);
  micro(treasuryUnitMicro);
  micro(artistUnitMicro);
  const unitTotal = treasuryUnitMicro + artistUnitMicro;
  const depositedMicro = count * unitTotal;
  micro(unitTotal);
  micro(depositedMicro);
  if (depositedMicro === 0) {
    throw new Error("The payment amount is outside the escrow limit.");
  }
  return { units: count, treasuryUnitMicro, artistUnitMicro, depositedMicro };
}

/** Pass the verified on-chain Config cap; no default or independent policy cap. */
export function escrowAmounts(
  count: number,
  treasuryUnitMicro: number,
  artistUnitMicro: number,
  maxDepositMicro: number,
): EscrowAmounts {
  micro(maxDepositMicro);
  const amounts = checkedAmounts(count, treasuryUnitMicro, artistUnitMicro);
  if (maxDepositMicro === 0 || amounts.depositedMicro > maxDepositMicro) {
    throw new Error("The payment amount is outside the escrow limit.");
  }
  return amounts;
}

/** Validate against the supplied chain clock, never the process's wall clock. */
export function validateEscrowExpiry(nowSeconds: number, expiresAtSeconds: number): void {
  micro(nowSeconds);
  micro(expiresAtSeconds);
  const ttl = expiresAtSeconds - nowSeconds;
  if (ttl < ESCROW_MIN_TTL_SECONDS || ttl > ESCROW_MAX_TTL_SECONDS) {
    throw new Error("The payment expiry is outside the escrow limits.");
  }
}

/** Missing/frozen artist accounts leave that entire leg available for refund. */
export function escrowSettlement(
  amounts: EscrowAmounts,
  deliveredUnits: number,
  artistPayable: boolean,
): { treasuryMicro: number; artistMicro: number; refundableMicro: number } {
  const checked = checkedAmounts(amounts.units, amounts.treasuryUnitMicro, amounts.artistUnitMicro);
  if (checked.depositedMicro !== amounts.depositedMicro) {
    throw new Error("The payment split does not match the deposit.");
  }
  if (!Number.isInteger(deliveredUnits) || deliveredUnits < 0 || deliveredUnits > amounts.units) {
    throw new Error("The delivered image count is invalid.");
  }
  const treasuryMicro = deliveredUnits * amounts.treasuryUnitMicro;
  const artistMicro = artistPayable ? deliveredUnits * amounts.artistUnitMicro : 0;
  return {
    treasuryMicro,
    artistMicro,
    refundableMicro: amounts.depositedMicro - treasuryMicro - artistMicro,
  };
}

/** Use recovery_unit_micro from the RPC row, never recalculate its debt formula. */
export function settledEscrowRecovery(
  count: number,
  deliveredUnits: number,
  unitRecoveryMicro: number,
): { recoveredMicro: number; releasedMicro: number } {
  units(count);
  micro(unitRecoveryMicro);
  if (!Number.isInteger(deliveredUnits) || deliveredUnits < 0 || deliveredUnits > count) {
    throw new Error("The delivered image count is invalid.");
  }
  const reserveMicro = count * unitRecoveryMicro;
  micro(reserveMicro);
  return {
    recoveredMicro: deliveredUnits * unitRecoveryMicro,
    releasedMicro: (count - deliveredUnits) * unitRecoveryMicro,
  };
}

/** Recreating a missing buyer ATA is funded by its stored rent payer on chain. */
export function escrowRefund(
  remainingMicro: number,
  buyerAtaExists: boolean,
  refundAtaFeeMicro: number,
): { buyerMicro: number; ataFeeMicro: number; createBuyerAta: boolean } {
  micro(remainingMicro);
  micro(refundAtaFeeMicro);
  if (refundAtaFeeMicro > ESCROW_MAX_REFUND_ATA_FEE_MICRO) {
    throw new Error("The account-creation fee exceeds the escrow cap.");
  }
  if (buyerAtaExists || remainingMicro === 0) {
    return { buyerMicro: remainingMicro, ataFeeMicro: 0, createBuyerAta: false };
  }
  if (remainingMicro < refundAtaFeeMicro) {
    return { buyerMicro: 0, ataFeeMicro: remainingMicro, createBuyerAta: false };
  }
  return {
    buyerMicro: remainingMicro - refundAtaFeeMicro,
    ataFeeMicro: refundAtaFeeMicro,
    createBuyerAta: true,
  };
}
