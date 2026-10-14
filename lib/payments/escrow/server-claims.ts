import { randomUUID } from "node:crypto";
import { address } from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ESCROW_MAX_UNITS } from "../escrow-amounts";
import { verifyFundedEscrow } from "./confirmation";
import { loadOwnedGenerationEscrow } from "./server-deposit";
import { EscrowPaymentError, type EscrowBank, type EscrowChain } from "./server-chain";

export interface GenerationEscrowUnitClaim {
  intentId: string;
  owner: string;
  unitIndex: number;
  claimToken: string;
  userId: string;
}
export interface GenerationEscrowBatch {
  intent_id: string;
  state: "open" | "closing" | "ready" | "settled" | "refunded" | "closed";
  delivered_units: number | null;
  settlement_signature: string | null;
}
interface UnitRow {
  intent_id: string;
  unit_index: number;
  state: "pending" | "running" | "delivered" | "failed";
  claim_token: string | null;
  user_id: string | null;
  generation_id: string | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => new EscrowPaymentError(503, "Payments are temporarily unavailable. Please try again later.");
const conflict = () => new EscrowPaymentError(409, "This image request cannot continue. Please check its status before trying again.");
const first = <T>(data: T | T[] | null): T | null => Array.isArray(data) ? data[0] ?? null : data;

async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw error instanceof EscrowPaymentError ? error : unavailable(); }
}
async function call<T>(db: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T | null> {
  return safe(async () => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw error.code === "22023" ? conflict() : unavailable();
    return first(data) as T | null;
  });
}
function confirmedSlot(value: number | string | null): bigint {
  if (value === null || !/^[1-9][0-9]*$/.test(String(value))) throw unavailable();
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw unavailable();
  return BigInt(value);
}
function validateBank(bank: EscrowBank, minimumSlot: bigint, depositedAt: number) {
  if (typeof bank.slot !== "bigint" || bank.slot < minimumSlot ||
      !Number.isSafeInteger(bank.chainNowSeconds) || bank.chainNowSeconds < depositedAt ||
      bank.accounts.length !== 2) throw unavailable();
}
function validateClaim(claim: GenerationEscrowUnitClaim) {
  if (!UUID.test(claim.intentId) || !UUID.test(claim.userId) || !UUID.test(claim.claimToken) ||
      !claim.owner || !Number.isInteger(claim.unitIndex) || claim.unitIndex < 0 || claim.unitIndex >= ESCROW_MAX_UNITS) {
    throw conflict();
  }
}
function sameClaim(row: UnitRow, claim: GenerationEscrowUnitClaim) {
  return row.intent_id === claim.intentId && row.unit_index === claim.unitIndex &&
    row.claim_token === claim.claimToken && row.user_id === claim.userId;
}
const claimArgs = (claim: GenerationEscrowUnitClaim) => ({
  p_intent_id: claim.intentId, p_owner_wallet: claim.owner,
  p_unit_index: claim.unitIndex, p_claim_token: claim.claimToken,
});

/** The authenticated user and owner come from the session, never the generation body. */
export async function claimGenerationEscrowUnit(db: SupabaseClient, chain: EscrowChain,
  { intentId, owner, userId, unitIndex }: { intentId: string; owner: string; userId: string; unitIndex: number }): Promise<GenerationEscrowUnitClaim> {
  if (!UUID.test(userId) || !Number.isInteger(unitIndex) || unitIndex < 0 || unitIndex >= ESCROW_MAX_UNITS) {
    throw new EscrowPaymentError(400, "Choose a valid image request.");
  }
  const { intent, row, snapshot } = await safe(() => loadOwnedGenerationEscrow(db, chain, intentId, owner));
  if (row.state !== "funded" || unitIndex >= snapshot.units) throw conflict();
  const minimumSlot = confirmedSlot(row.confirmed_slot);
  const bank = await safe(() => chain.accounts([address(row.escrow_address), address(row.vault_address)], "confirmed", minimumSlot));
  validateBank(bank, minimumSlot, snapshot.chainNowSeconds);
  const [escrow, vault] = bank.accounts;
  if (!escrow || !vault) throw conflict();
  try {
    await verifyFundedEscrow(snapshot, {
      commitment: "confirmed", contextSlot: bank.slot, minimumSlot,
      chainNowSeconds: bank.chainNowSeconds, escrow, vault,
    });
  } catch { throw conflict(); }
  const claim: GenerationEscrowUnitClaim = { intentId, owner: intent.buyer_wallet, unitIndex, claimToken: randomUUID(), userId };
  const acquired = await call<UnitRow>(db, "claim_generation_escrow_unit", {
    ...claimArgs(claim), p_user_id: userId,
    p_chain_now_seconds: bank.chainNowSeconds, p_admitted_slot: bank.slot.toString(),
  });
  // An empty result includes already-running/delivered units. It never starts another provider call.
  if (!acquired) throw conflict();
  if (acquired.state !== "running" || !sameClaim(acquired, claim)) throw unavailable();
  return claim;
}

/** Only invoke after persisting the accepted generated image and its generation row. */
export async function deliverGenerationEscrowUnit(db: SupabaseClient, claim: GenerationEscrowUnitClaim, generationId: string): Promise<void> {
  validateClaim(claim);
  if (!UUID.test(generationId)) throw conflict();
  const delivered = await call<UnitRow>(db, "deliver_generation_escrow_unit", {
    ...claimArgs(claim), p_generation_id: generationId,
  });
  if (!delivered || delivered.state !== "delivered" || delivered.generation_id !== generationId || !sameClaim(delivered, claim)) {
    throw unavailable();
  }
}

/** A failed or abandoned unit can never be claimed again, and cannot undo a delivered unit. */
export async function failGenerationEscrowUnit(db: SupabaseClient, claim: GenerationEscrowUnitClaim): Promise<void> {
  validateClaim(claim);
  const failed = await call<UnitRow>(db, "fail_generation_escrow_unit", claimArgs(claim));
  if (failed && (failed.state !== "failed" || !sameClaim(failed, claim))) throw unavailable();
}

/** Freeze only SQL's durable delivered-row count. Closing also works after expiry or settlement. */
export async function closeGenerationEscrowBatch(db: SupabaseClient, chain: EscrowChain,
  intentId: string, owner: string, cancel = false): Promise<GenerationEscrowBatch> {
  const { intent, row, snapshot } = await safe(() => loadOwnedGenerationEscrow(db, chain, intentId, owner));
  if (row.state !== "funded" || typeof cancel !== "boolean") throw conflict();
  const minimumSlot = confirmedSlot(row.confirmed_slot);
  const bank = await safe(() => chain.accounts([address(row.escrow_address), address(row.vault_address)], "confirmed", minimumSlot));
  validateBank(bank, minimumSlot, snapshot.chainNowSeconds);
  const batch = await call<GenerationEscrowBatch>(db, "close_generation_escrow_batch", {
    p_intent_id: intentId, p_owner_wallet: intent.buyer_wallet,
    p_chain_now_seconds: bank.chainNowSeconds, p_cancel: cancel,
  });
  if (!batch || batch.intent_id !== intentId || !["open", "closing", "ready", "settled", "refunded", "closed"].includes(batch.state)) {
    throw unavailable();
  }
  const frozen = ["ready", "settled", "refunded", "closed"].includes(batch.state);
  if (frozen ? !Number.isInteger(batch.delivered_units) || batch.delivered_units! < 0 || batch.delivered_units! > snapshot.units : batch.delivered_units !== null) {
    throw unavailable();
  }
  return batch;
}
