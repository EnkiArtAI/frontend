import { address } from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import { escrowAddresses } from "./addresses";
import { verifyFundedEscrow } from "./confirmation";
import { CONFIG_DISCRIMINATOR, EscrowState, getConfigDecoder } from "./generated";
import { prepareEscrowReclaim, prepareEscrowSettlement, readEscrowSnapshot, verifySettledEscrow } from "./lifecycle";
import { closeGenerationEscrowBatch, type GenerationEscrowBatch } from "./server-claims";
import { EscrowPaymentError, type EscrowBank, type EscrowChain, type EscrowReceipt } from "./server-chain";
import { escrowBytea, loadOwnedGenerationEscrow } from "./server-deposit";

type Context = Awaited<ReturnType<typeof loadOwnedGenerationEscrow>>;
interface Attempt {
  id: string; intent_id: string; kind: "settle" | "reclaim"; state: "submitted" | "confirmed" | "expired";
  signed_transaction: string; signature: string; blockhash: string; last_valid_block_height: string | number;
}
export interface EscrowLifecycleProgress {
  batch: GenerationEscrowBatch; pending: boolean; action: "none" | "settle" | "reclaim" | "expired";
}
/** Stable diagnostic codes are for server monitoring; the UI receives a plain sentence. */
export class EscrowReconciliationError extends EscrowPaymentError {
  constructor(readonly reason: string) { super(409, "This payment needs a status check before it can continue."); }
}
const unavailable = () => new EscrowPaymentError(503, "Payments are temporarily unavailable. Please check their status later.");
const first = <T>(data: T | T[] | null): T | null => Array.isArray(data) ? data[0] ?? null : data;
const progress = (batch: GenerationEscrowBatch, action: EscrowLifecycleProgress["action"] = "none", pending = false): EscrowLifecycleProgress => ({ batch, action, pending });
async function rpc<T>(db: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error || !first(data)) throw unavailable();
  return first(data) as T;
}
function positiveSlot(value: string | number | null): bigint {
  if (!value || !/^[1-9][0-9]*$/.test(String(value)) || (typeof value === "number" && !Number.isSafeInteger(value))) throw unavailable();
  return BigInt(value);
}
async function snapshot(chain: EscrowChain, ctx: Context, commitment: "confirmed" | "finalized", minimumSlot?: bigint): Promise<EscrowBank> {
  const bank = await chain.accounts([address(ctx.row.escrow_address), address(ctx.row.vault_address)], commitment,
    minimumSlot ?? positiveSlot(ctx.row.confirmed_slot));
  if (bank.slot < (minimumSlot ?? positiveSlot(ctx.row.confirmed_slot)) || bank.accounts.length !== 2 ||
      !Number.isSafeInteger(bank.chainNowSeconds) || bank.chainNowSeconds < ctx.snapshot.chainNowSeconds) throw unavailable();
  return bank;
}
async function pendingAttempt(db: SupabaseClient, id: string, kind: Attempt["kind"]): Promise<Attempt | null> {
  const { data, error } = await db.from("generation_escrow_transactions")
    .select("id,intent_id,kind,state,signed_transaction,signature,blockhash,last_valid_block_height")
    .eq("intent_id", id).eq("kind", kind).eq("state", "submitted").maybeSingle();
  if (error) throw unavailable();
  return data as Attempt | null;
}
async function checkDeliveredCount(db: SupabaseClient, batch: GenerationEscrowBatch) {
  const { data, error } = await db.from("generation_escrow_units").select("unit_index")
    .eq("intent_id", batch.intent_id).eq("state", "delivered");
  if (error || !data) throw unavailable();
  // The immutable unit ledger survives a gallery deletion. The request never supplies k.
  if (batch.delivered_units !== data.length) throw new EscrowReconciliationError("delivered_count_mismatch");
}
async function funded(ctx: Context, bank: EscrowBank) {
  const [escrow, vault] = bank.accounts;
  if (!escrow || !vault) throw new EscrowReconciliationError("missing_funded_accounts");
  try {
    await verifyFundedEscrow(ctx.snapshot, { commitment: "confirmed", contextSlot: bank.slot,
      minimumSlot: positiveSlot(ctx.row.confirmed_slot), chainNowSeconds: bank.chainNowSeconds,
      allowExpired: true, escrow, vault });
  } catch { throw new EscrowReconciliationError("funding_proof_mismatch"); }
}
async function settled(ctx: Context, batch: GenerationEscrowBatch, bank: EscrowBank, minimumSlot: bigint) {
  const [escrow, vault] = bank.accounts;
  if (!escrow || !vault || batch.delivered_units === null) throw new EscrowReconciliationError("missing_settlement_accounts");
  try { await verifySettledEscrow(ctx.snapshot, batch.delivered_units, { contextSlot: bank.slot, minimumSlot, escrow, vault }); }
  catch { throw new EscrowReconciliationError("settled_units_mismatch"); }
}
function successful(receipt: EscrowReceipt | null): receipt is EscrowReceipt & { failed: false; commitment: "confirmed" | "finalized" } {
  return !!receipt && !receipt.failed && (receipt.commitment === "confirmed" || receipt.commitment === "finalized");
}
async function confirm(db: SupabaseClient, ctx: Context, attempt: Attempt, slot: bigint) {
  return rpc<GenerationEscrowBatch>(db, "confirm_generation_escrow_transaction", {
    p_intent_id: ctx.intent.id, p_owner_wallet: ctx.intent.buyer_wallet, p_transaction_id: attempt.id,
    p_signature: attempt.signature, p_confirmed_slot: slot.toString(),
  });
}
/** Verify a receipt before any retry, and retain the original signed wire through uncertainty. */
async function reconcileAttempt(db: SupabaseClient, chain: EscrowChain, ctx: Context,
  batch: GenerationEscrowBatch, attempt: Attempt): Promise<EscrowLifecycleProgress> {
  if (attempt.intent_id !== ctx.intent.id || attempt.state !== "submitted") throw unavailable();
  const receipt = await chain.receipt(attempt.signature);
  if (successful(receipt)) {
    const bank = await snapshot(chain, ctx, "confirmed", receipt.slot > positiveSlot(ctx.row.confirmed_slot) ? receipt.slot : positiveSlot(ctx.row.confirmed_slot));
    if (attempt.kind === "settle") await settled(ctx, batch, bank, receipt.slot);
    else if (bank.accounts.some(account => account !== null)) throw new EscrowReconciliationError("reclaim_accounts_still_present");
    return progress(await confirm(db, ctx, attempt, receipt.slot), attempt.kind);
  }
  const lastHeight = BigInt(attempt.last_valid_block_height);
  if (await chain.height("confirmed") <= lastHeight) {
    try {
      const signature = await chain.broadcast(escrowBytea(attempt.signed_transaction).toString("base64"));
      if (signature !== attempt.signature) throw new EscrowReconciliationError("broadcast_signature_mismatch");
    } catch (error) {
      if (error instanceof EscrowReconciliationError) throw error;
      // The node may have accepted the transaction. The next call checks this exact signature.
    }
    return progress(batch, attempt.kind, true);
  }
  // A processed success or an unfinalized failure can still become the canonical receipt.
  if (receipt && (!receipt.failed || receipt.commitment !== "finalized")) return progress(batch, attempt.kind, true);
  const bank = await snapshot(chain, ctx, "finalized", receipt?.slot && receipt.slot > positiveSlot(ctx.row.confirmed_slot) ? receipt.slot : positiveSlot(ctx.row.confirmed_slot));
  const height = await chain.finalizedHeight(bank.slot);
  if (height <= lastHeight) return progress(batch, attempt.kind, true);
  // Receipt absence alone cannot prove expiry if its effect is visible in this finalized bank.
  if (attempt.kind === "settle") await funded(ctx, bank);
  else if (batch.state === "settled") await settled(ctx, batch, bank, positiveSlot(ctx.row.confirmed_slot));
  else {
    await funded(ctx, bank);
    if (bank.chainNowSeconds < ctx.snapshot.expiresAtSeconds) throw new EscrowReconciliationError("reclaim_before_expiry");
  }
  await rpc<Attempt>(db, "expire_generation_escrow_transaction", {
    p_intent_id: ctx.intent.id, p_owner_wallet: ctx.intent.buyer_wallet, p_transaction_id: attempt.id,
    p_finalized_block_height: height.toString(), p_absence_checked_slot: bank.slot.toString(),
  });
  return progress(batch, "expired", true);
}
async function assertCurrentOperator(chain: EscrowChain, ctx: Context) {
  const derived = await escrowAddresses(chain.programAddress, ctx.snapshot.buyer, ctx.intent.id);
  const bank = await chain.accounts([derived.config], "confirmed", positiveSlot(ctx.row.confirmed_slot));
  const account = bank.accounts[0];
  if (!account || account.address !== derived.config || account.programAddress !== chain.programAddress ||
      account.executable || account.data.length !== getConfigDecoder().fixedSize) throw unavailable();
  const config = getConfigDecoder().decode(account.data);
  if (!Buffer.from(config.discriminator).equals(Buffer.from(CONFIG_DISCRIMINATOR)) ||
      config.bump !== derived.configBump || config.operator !== chain.operatorAddress) throw unavailable();
  // Pausing admissions must not block settlement of already-funded orders.
}

/** One separately persisted transaction per call. Never bundle settlement with reclaim or ATA creation. */
export async function advanceGenerationEscrow(db: SupabaseClient, chain: EscrowChain,
  intentId: string, owner: string, cancel = false): Promise<EscrowLifecycleProgress> {
  const ctx = await loadOwnedGenerationEscrow(db, chain, intentId, owner);
  if (ctx.row.state !== "funded") throw new EscrowPaymentError(409, "Wait for payment confirmation before continuing.");
  const batch = await closeGenerationEscrowBatch(db, chain, intentId, ctx.intent.buyer_wallet, cancel);
  if (batch.state === "closed") return progress(batch);
  if (batch.state === "open" || batch.state === "closing") return progress(batch, "none", true);
  await checkDeliveredCount(db, batch);
  if (batch.state === "ready") {
    const settle = await pendingAttempt(db, intentId, "settle");
    if (settle) return reconcileAttempt(db, chain, ctx, batch, settle);
  }
  const reclaim = await pendingAttempt(db, intentId, "reclaim");
  if (reclaim) return reconcileAttempt(db, chain, ctx, batch, reclaim);
  const bank = await snapshot(chain, ctx, "confirmed");
  const escrow = bank.accounts[0];
  if (!escrow) throw new EscrowReconciliationError("missing_escrow_without_receipt");
  const state = (await readEscrowSnapshot(ctx.snapshot, escrow)).state;
  const kind = batch.state === "ready" && bank.chainNowSeconds < ctx.snapshot.expiresAtSeconds ? "settle" : "reclaim";
  if (batch.state === "ready") {
    if (state !== EscrowState.Funded) throw new EscrowReconciliationError("unexpected_settlement");
    await funded(ctx, bank);
  } else await settled(ctx, batch, bank, positiveSlot(ctx.row.confirmed_slot));
  if (kind === "settle") await assertCurrentOperator(chain, ctx);
  const signer = await chain.operatorKeyPair();
  const lifetime = await chain.lifetime();
  const signed = kind === "settle" ? await prepareEscrowSettlement(ctx.snapshot, batch.delivered_units!, signer, lifetime)
    : await prepareEscrowReclaim(ctx.snapshot, signer, lifetime);
  // Under contention the RPC returns the FIRST stored wire, which may differ from this builder's.
  const winning = await rpc<Attempt>(db, "store_generation_escrow_transaction", {
    p_intent_id: intentId, p_owner_wallet: ctx.intent.buyer_wallet, p_kind: kind,
    p_signed_transaction: `\\x${Buffer.from(signed.signedTransactionBase64, "base64").toString("hex")}`,
    p_signature: signed.signature, p_blockhash: signed.blockhash,
    p_last_valid_block_height: signed.lastValidBlockHeight, p_chain_now_seconds: bank.chainNowSeconds,
  });
  if (winning.state === "confirmed") return progress(await closeGenerationEscrowBatch(db, chain, intentId, ctx.intent.buyer_wallet), kind);
  if (winning.kind !== kind) throw unavailable();
  return reconcileAttempt(db, chain, ctx, batch, winning);
}
