import type { SupabaseClient } from "@supabase/supabase-js";
import { advanceGenerationEscrow, EscrowReconciliationError } from "./server-lifecycle";
import { expireUnfundedGenerationEscrow, generationEscrowStatus, retrySubmittedGenerationEscrow } from "./server-deposit";
import type { EscrowChain } from "./server-chain";

/** Bounded sweep: retry persisted wires, expire only with proof, then reclaim on later calls. */
export async function sweepGenerationEscrows(db: SupabaseClient, chain: EscrowChain, limit = 20, stopAt = Date.now() + 120_000) {
  const { data, error } = await db.rpc("generation_escrow_work_items", { p_limit: Math.min(50, Math.max(1, limit)) });
  if (error) throw new Error("Escrow candidates are unavailable.");
  let checked = 0, pending = 0, closed = 0, alerts = 0;
  for (const item of data ?? []) {
    if (Date.now() >= stopAt) break;
    checked++;
    try {
      const status = item.deposit_state === "submitted"
        ? await retrySubmittedGenerationEscrow(db, chain, item.intent_id, item.owner_wallet)
        : await generationEscrowStatus(db, chain, item.intent_id, item.owner_wallet);
      if (!status.funded) {
        const expired = await expireUnfundedGenerationEscrow(db, chain, item.intent_id, item.owner_wallet);
        if (expired.state !== "expired") pending++;
        continue;
      }
      const result = await advanceGenerationEscrow(db, chain, item.intent_id, item.owner_wallet);
      if (result.batch.state === "closed") closed++; else pending++;
    } catch (error) {
      alerts++;
      // Stable labels and payment IDs belong in server monitoring; credentials and upstream errors do not.
      console.error("[escrow/reconcile]", error instanceof EscrowReconciliationError ? error.reason : "temporarily_unavailable", item.intent_id);
    }
  }
  return { checked, pending, closed, alerts };
}
