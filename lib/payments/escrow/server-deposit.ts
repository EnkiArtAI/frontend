import { randomUUID } from "node:crypto";
import { address, type Address } from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ESCROW_MAX_UNITS } from "../escrow-amounts";
import { EMPTY_RECIPIENT, escrowAddresses, escrowMint } from "./addresses";
import { validateEscrowConfiguration, verifyFundedEscrow } from "./confirmation";
import { coSignEscrowDeposit, prepareEscrowDeposit, verifyBuyerEscrowDeposit, type EscrowPaymentSnapshot } from "./deposit";
import { getConfigDecoder } from "./generated";
import { EscrowPaymentError, type EscrowChain } from "./server-chain";

interface Intent {
  id: string; buyer_wallet: string; artist_wallet: string | null;
  total_micro: number; artist_amount_micro: number;
}
interface Recovery {
  units: number; mint: string; treasury_unit_micro: number | string;
  artist_unit_micro: number | string; recovery_unit_micro: number | string;
}
export interface EscrowDepositRow {
  intent_id: string; program_address: string; cluster: "solana" | "solana-devnet";
  buyer_address: string; rent_payer: string; treasury_owner: string;
  escrow_address: string; vault_address: string; unsigned_transaction: string;
  message: string; blockhash: string; last_valid_block_height: number | string;
  chain_now_seconds: number | string; expires_at_seconds: number | string;
  state: "prepared" | "submitting" | "submitted" | "funded" | "expired";
  signed_transaction: string | null; signature: string | null;
  confirmed_slot: number | string | null;
}
const DEPOSIT_COLUMNS = "intent_id,program_address,cluster,buyer_address,rent_payer,treasury_owner,escrow_address,vault_address,unsigned_transaction,message,blockhash,last_valid_block_height,chain_now_seconds,expires_at_seconds,state,signed_transaction,signature,confirmed_slot";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => new EscrowPaymentError(503, "Payments are temporarily unavailable. Please try again later.");
const conflict = () => new EscrowPaymentError(409, "This payment cannot continue. Please check its status before trying again.");
const missing = () => new EscrowPaymentError(404, "The payment was not found.");
function dbError(error: { code?: string } | null) {
  if (error) throw error.code === "22023" ? conflict() : unavailable();
}
function first<T>(data: T | T[] | null): T | null { return Array.isArray(data) ? data[0] ?? null : data; }
function integer(value: string | number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw unavailable();
  return n;
}
export function escrowBytea(value: string): Buffer {
  if (!/^\\x(?:[a-f0-9]{2})+$/i.test(value)) throw unavailable();
  return Buffer.from(value.slice(2), "hex");
}
const bytea = (base64: string) => `\\x${Buffer.from(base64, "base64").toString("hex")}`;

/** Owner is the authenticated session's identifier, never a body parameter. */
export async function ownedEscrowIntent(db: SupabaseClient, intentId: string, owner: string): Promise<Intent> {
  if (!UUID.test(intentId)) throw missing();
  const { data, error } = await db.from("generation_payment_intents")
    .select("id,buyer_wallet,artist_wallet,total_micro,artist_amount_micro")
    .eq("id", intentId).eq("buyer_wallet", owner).maybeSingle();
  dbError(error);
  if (!data) throw missing();
  return data as Intent;
}
async function depositRow(db: SupabaseClient, id: string): Promise<EscrowDepositRow | null> {
  const { data, error } = await db.from("generation_escrow_deposits")
    .select(DEPOSIT_COLUMNS).eq("intent_id", id).maybeSingle();
  dbError(error);
  return data as EscrowDepositRow | null;
}
async function recoveryRow(db: SupabaseClient, id: string): Promise<Recovery> {
  const { data, error } = await db.from("generation_escrow_recovery")
    .select("units,mint,treasury_unit_micro,artist_unit_micro,recovery_unit_micro")
    .eq("intent_id", id).single();
  dbError(error);
  if (!data) throw unavailable();
  return data as Recovery;
}
async function buyerAddress(db: SupabaseClient, owner: string): Promise<Address> {
  let query = db.from("user_wallets").select("address").eq("chain_family", "solana").is("removed_at", null);
  query = UUID.test(owner) ? query.eq("user_id", owner).eq("is_primary", true) : query.eq("address", owner);
  const { data, error } = await query.maybeSingle();
  dbError(error);
  if (!data) throw new EscrowPaymentError(409, "Connect a Solana wallet before continuing with this payment.");
  try { return address(data.address); } catch { throw unavailable(); }
}
export function escrowDepositSnapshot(intent: Intent, row: EscrowDepositRow, recovery: Recovery): EscrowPaymentSnapshot {
  if (recovery.mint !== escrowMint(row.cluster)) throw unavailable();
  const artistUnitMicro = integer(recovery.artist_unit_micro);
  return {
    programAddress: address(row.program_address), cluster: row.cluster, intentId: intent.id,
    buyer: address(row.buyer_address), rentPayer: address(row.rent_payer), treasuryOwner: address(row.treasury_owner),
    artistOwner: artistUnitMicro > 0 ? address(intent.artist_wallet ?? "") : EMPTY_RECIPIENT,
    units: recovery.units, treasuryUnitMicro: integer(recovery.treasury_unit_micro), artistUnitMicro,
    chainNowSeconds: integer(row.chain_now_seconds), expiresAtSeconds: integer(row.expires_at_seconds),
  };
}
async function onDeployment(chain: EscrowChain, row: EscrowDepositRow) {
  if (row.cluster !== chain.cluster || row.program_address !== chain.programAddress) throw unavailable();
  const derived = await escrowAddresses(chain.programAddress, address(row.buyer_address), row.intent_id);
  if (row.escrow_address !== derived.escrow || row.vault_address !== derived.vault) throw unavailable();
}
function preparedResponse(row: EscrowDepositRow, recovery: Recovery) {
  if (row.state !== "prepared") throw conflict();
  return { intentId: row.intent_id, transaction: escrowBytea(row.unsigned_transaction).toString("base64"),
    units: recovery.units, expiresAt: new Date(integer(row.expires_at_seconds) * 1000).toISOString(),
    paymentScheme: "escrow" as const };
}

export async function prepareGenerationEscrow(db: SupabaseClient, chain: EscrowChain,
  { intentId, owner, units }: { intentId: string; owner: string; units: number }) {
  if (!Number.isInteger(units) || units < 1 || units > ESCROW_MAX_UNITS) {
    throw new EscrowPaymentError(400, "Choose between one and twenty-four images.");
  }
  const intent = await ownedEscrowIntent(db, intentId, owner);
  const existing = await depositRow(db, intentId);
  if (existing) {
    await onDeployment(chain, existing);
    const recovery = await recoveryRow(db, intentId);
    if (recovery.units !== units) throw conflict();
    // Reuse the original bytes; never rebuild a wallet's outstanding payment.
    return preparedResponse(existing, recovery);
  }
  const buyer = await buyerAddress(db, owner);
  const derived = await escrowAddresses(chain.programAddress, buyer, intentId);
  const bank = await chain.accounts([derived.config], "confirmed");
  const account = bank.accounts[0];
  if (!account) throw unavailable();
  let config;
  try { config = getConfigDecoder().decode(account.data); } catch { throw unavailable(); }
  const initial: EscrowPaymentSnapshot = {
    programAddress: chain.programAddress, cluster: chain.cluster, intentId, buyer,
    rentPayer: chain.operatorAddress, treasuryOwner: config.treasuryOwner,
    artistOwner: intent.artist_amount_micro > 0 ? address(intent.artist_wallet ?? "") : EMPTY_RECIPIENT,
    units, treasuryUnitMicro: integer(intent.total_micro) - integer(intent.artist_amount_micro),
    artistUnitMicro: integer(intent.artist_amount_micro), chainNowSeconds: bank.chainNowSeconds,
    expiresAtSeconds: bank.chainNowSeconds + Number(config.maxTtlS),
  };
  // Validate ownership, discriminator, canonical PDA, policy and aggregate cap BEFORE SQL reservation.
  try { config = await validateEscrowConfiguration(initial, account); } catch { throw unavailable(); }
  const reserved = await db.rpc("reserve_generation_escrow_recovery", {
    p_intent_id: intentId, p_units: units, p_mint: escrowMint(chain.cluster),
    p_max_deposit_micro: Number(config.maxDepositMicro),
  });
  dbError(reserved.error);
  const recovery = first(reserved.data) as Recovery | null;
  if (!recovery || recovery.units !== units || recovery.mint !== escrowMint(chain.cluster)) throw unavailable();
  const artistUnitMicro = integer(recovery.artist_unit_micro);
  const plan = { ...initial,
    artistOwner: artistUnitMicro > 0 ? initial.artistOwner : EMPTY_RECIPIENT,
    treasuryUnitMicro: integer(recovery.treasury_unit_micro), artistUnitMicro,
    maxDepositMicro: Number(config.maxDepositMicro),
  };
  const prepared = await prepareEscrowDeposit(plan, await chain.lifetime());
  const stored = await db.rpc("prepare_generation_escrow_deposit", {
    p_intent_id: intentId, p_owner_wallet: intent.buyer_wallet,
    p_program_address: chain.programAddress, p_cluster: chain.cluster,
    p_buyer_address: prepared.buyer, p_rent_payer: prepared.rentPayer, p_treasury_owner: plan.treasuryOwner,
    p_escrow_address: prepared.escrowAddress, p_vault_address: prepared.vaultAddress,
    p_unsigned_transaction: bytea(prepared.unsignedTransactionBase64), p_message: bytea(prepared.messageBase64),
    p_blockhash: prepared.blockhash, p_last_valid_block_height: prepared.lastValidBlockHeight,
    p_chain_now_seconds: plan.chainNowSeconds, p_expires_at_seconds: plan.expiresAtSeconds,
  });
  dbError(stored.error);
  const row = first(stored.data) as EscrowDepositRow | null;
  if (!row) throw unavailable();
  await onDeployment(chain, row);
  return preparedResponse(row, recovery);
}

export type EscrowDepositStatus = { intentId: string; paymentScheme: "escrow"; state: EscrowDepositRow["state"]; funded: boolean };
const statusOf = (row: EscrowDepositRow): EscrowDepositStatus => ({
  intentId: row.intent_id, paymentScheme: "escrow", state: row.state, funded: row.state === "funded",
});
async function confirmDeposit(db: SupabaseClient, chain: EscrowChain, intent: Intent,
  row: EscrowDepositRow): Promise<EscrowDepositStatus> {
  if (row.state !== "submitted" || !row.signature) return statusOf(row);
  const receipt = await chain.receipt(row.signature);
  if (!receipt || receipt.failed || !["confirmed", "finalized"].includes(receipt.commitment ?? "")) return statusOf(row);
  const recovery = await recoveryRow(db, intent.id);
  const snapshot = escrowDepositSnapshot(intent, row, recovery);
  const bank = await chain.accounts([address(row.escrow_address), address(row.vault_address)], "confirmed", receipt.slot);
  const [escrow, vault] = bank.accounts;
  if (!escrow || !vault) return statusOf(row);
  try {
    await verifyFundedEscrow(snapshot, { commitment: "confirmed", contextSlot: bank.slot,
      minimumSlot: receipt.slot, chainNowSeconds: bank.chainNowSeconds, escrow, vault });
  } catch { throw new EscrowPaymentError(409, "The confirmed payment could not be verified. Please check its status."); }
  const result = await db.rpc("confirm_generation_escrow_deposit", {
    p_intent_id: intent.id, p_owner_wallet: intent.buyer_wallet, p_signature: row.signature,
    p_confirmed_slot: receipt.slot.toString(),
  });
  dbError(result.error);
  const confirmed = first(result.data) as EscrowDepositRow | null;
  if (!confirmed) throw unavailable();
  return statusOf(confirmed);
}

export async function submitGenerationEscrow(db: SupabaseClient, chain: EscrowChain,
  { intentId, owner, signedTransaction }: { intentId: string; owner: string; signedTransaction: string }) {
  const intent = await ownedEscrowIntent(db, intentId, owner);
  let row = await depositRow(db, intentId);
  if (!row) throw missing();
  await onDeployment(chain, row);
  const prepared = { messageBase64: escrowBytea(row.message).toString("base64"),
    buyer: address(row.buyer_address), rentPayer: address(row.rent_payer) };
  // Invalid messages/signatures never acquire the submission lease or use the operator key.
  try { await verifyBuyerEscrowDeposit(prepared, signedTransaction); }
  catch { throw new EscrowPaymentError(400, "The wallet signature does not match the prepared payment."); }
  if (row.state === "expired") throw conflict();
  if (row.state === "prepared") {
    const recovery = await recoveryRow(db, intentId);
    const snapshot = escrowDepositSnapshot(intent, row, recovery);
    const derived = await escrowAddresses(chain.programAddress, snapshot.buyer, intentId);
    const bank = await chain.accounts([derived.config], "confirmed");
    if (!bank.accounts[0]) throw unavailable();
    let config;
    try { config = await validateEscrowConfiguration(snapshot, bank.accounts[0]); } catch { throw unavailable(); }
    if (snapshot.rentPayer !== chain.operatorAddress ||
        BigInt(snapshot.expiresAtSeconds - bank.chainNowSeconds) < config.minTtlS ||
        BigInt(snapshot.expiresAtSeconds - bank.chainNowSeconds) > config.maxTtlS) throw conflict();
    const token = randomUUID();
    const acquired = await db.rpc("begin_generation_escrow_submit", {
      p_intent_id: intentId, p_owner_wallet: intent.buyer_wallet, p_submission_token: token,
      p_current_block_height: (await chain.height("confirmed", bank.slot)).toString(),
    });
    dbError(acquired.error);
    if (first(acquired.data)) {
      const signed = await coSignEscrowDeposit(prepared, signedTransaction, await chain.operatorKeyPair());
      const stored = await db.rpc("store_generation_escrow_signed_deposit", {
        p_intent_id: intentId, p_owner_wallet: intent.buyer_wallet, p_submission_token: token,
        p_signed_transaction: bytea(signed.signedTransactionBase64), p_signature: signed.depositSignature,
      });
      dbError(stored.error);
      row = first(stored.data) as EscrowDepositRow | null;
    } else row = await depositRow(db, intentId);
    if (!row) throw unavailable();
  }
  if (row.state === "submitted" && row.signed_transaction && row.signature) {
    const verified = await confirmDeposit(db, chain, intent, row);
    if (verified.funded) return verified;
    // Persist first. An ambiguous RPC failure leaves the same stored wire retryable.
    if (await chain.height("confirmed") <= BigInt(row.last_valid_block_height)) {
      try {
        const signature = await chain.broadcast(escrowBytea(row.signed_transaction).toString("base64"));
        if (signature !== row.signature) throw unavailable();
      } catch (error) {
        if (!(error instanceof EscrowPaymentError)) throw unavailable();
        return statusOf(row);
      }
    }
    return confirmDeposit(db, chain, intent, row);
  }
  return statusOf(row);
}

export async function generationEscrowStatus(db: SupabaseClient, chain: EscrowChain, intentId: string, owner: string) {
  const intent = await ownedEscrowIntent(db, intentId, owner);
  const row = await depositRow(db, intentId);
  if (!row) throw missing();
  await onDeployment(chain, row);
  return confirmDeposit(db, chain, intent, row);
}

/** Absence and blockheight must belong to the SAME finalized bank. Wall time is not proof. */
export async function expireUnfundedGenerationEscrow(db: SupabaseClient, chain: EscrowChain, intentId: string, owner: string) {
  const intent = await ownedEscrowIntent(db, intentId, owner);
  const row = await depositRow(db, intentId);
  if (!row) throw missing();
  await onDeployment(chain, row);
  if (row.state === "funded" || row.state === "expired") return statusOf(row);
  const receipt = row.signature ? await chain.receipt(row.signature) : null;
  if (receipt && (!receipt.failed || receipt.commitment !== "finalized")) return statusOf(row);
  const bank = await chain.accounts([address(row.escrow_address), address(row.vault_address)],
    "finalized", receipt?.slot);
  const height = await chain.finalizedHeight(bank.slot);
  if (height <= BigInt(row.last_valid_block_height) || bank.accounts.some(account => account !== null)) return statusOf(row);
  const result = await db.rpc("expire_unfunded_generation_escrow_deposit", {
    p_intent_id: intent.id, p_owner_wallet: intent.buyer_wallet,
    p_finalized_block_height: height.toString(), p_absence_checked_slot: bank.slot.toString(),
  });
  dbError(result.error);
  const expired = first(result.data) as EscrowDepositRow | null;
  if (!expired) throw unavailable();
  return statusOf(expired);
}
