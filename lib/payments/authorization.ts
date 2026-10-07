/**
 * The life of one generation authorisation.
 *
 * Kev, 2026-08-06: "once the image goes through, we will receive the money.
 * otherwise it will be sent back." Taken literally that rules out a refund
 * worker, because a refund presupposes a charge that should not have happened.
 * So nothing is charged until the image exists.
 *
 * The buyer signs a Solana transfer built on a durable nonce and we hold it
 * unbroadcast. That signature is an authorisation, not a payment, and it ends
 * exactly one of two ways:
 *
 *   capture  we broadcast it        the image was delivered
 *   void     we advance the nonce   nothing was, or ever will be, charged
 *
 * Both are claimed with a conditional UPDATE that demands the other be unset,
 * so a race has a loser rather than two winners. Broadcasting AND flushing the
 * same nonce is the one outcome this file exists to make impossible.
 *
 * ── The abort condition ─────────────────────────────────────────────────
 * The authorisation dies at the first terminal state that is not delivery,
 * and otherwise at a DEADLINE measured from the moment work started.
 *
 * This used to be a heartbeat: the running job renewed its claim every 15s and
 * three missed beats meant abandoned. The argument for it was that a deadline
 * would kill slow-but-legitimate generations. On this platform that argument
 * does not hold — the generate route's own budget ladder makes the upper bound
 * a fact rather than a guess:
 *
 *     285s  the route's in-process timeout
 *     300s  maxDuration — Vercel kills the function here
 *     330s  SLOT_TTL_MS
 *     360s  everything above has expired; the worker is provably gone
 *
 * A generation CANNOT run past 300s, so nothing legitimate is ever cut short
 * by waiting 360. The heartbeat was solving a problem the platform already
 * solves, and it cost more than it bought: it needed a beat, a timer, a
 * lost() signal nobody branched on, and it made the sweep's SELECT and its
 * write disagree about a moving value — a race that voided live authorisations
 * and shipped their images free.
 *
 * consumed_at is the anchor instead, set once by claimForGeneration when the
 * work actually starts. It never moves, so selection and execution cannot
 * disagree. Same rule generation-redemption.ts already used to decide a claim
 * is provably dead.
 *
 * IF ENKI EVER LEAVES VERCEL this reasoning goes with it (Kev, 2026-08-19).
 * Without a platform-enforced maxDuration there is no upper bound to derive a
 * deadline from, and the heartbeat has to come back — it is in the history of
 * this file, not lost.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptString, decryptString } from "@/lib/crypto";

const TABLE = "generation_payment_intents";

/**
 * Past this, the worker that claimed an authorisation is provably gone: the
 * route's function budget (maxDuration 300s) and the concurrency slot TTL
 * (330s) have both expired. The same number and the same reasoning as
 * STALE_CLAIM_MS in generation-redemption.ts, which decides the identical
 * question for the prepaid path.
 *
 * Lower than this and the sweep races a generation that is still running,
 * which either lets one payment buy two images or hands the first one over
 * unpaid.
 */
export const ABANDONED_AFTER_MS = 360_000;

export type VoidReason =
  | "provider_failed"
  | "rejected"
  | "cancelled"
  | "abandoned"
  | "expired";

export interface HeldAuthorization {
  intentId: string;
  /** The signed, unbroadcast transaction, base64. */
  signedTx: string;
  nonceAccount: string | null;
  totalMicro: number;
}

/** Bind the ciphertext to its row: a signed tx copied into another intent will not open. */
const aadFor = (intentId: string) => `intent:${intentId}`;

const nowIso = () => new Date().toISOString();
const staleCutoff = () => new Date(Date.now() - ABANDONED_AFTER_MS).toISOString();

/**
 * Record the buyer's signature and start beating in one write.
 *
 * consumed_at stays NULL until claimForGeneration takes the work. An
 * authorisation that is signed and never claimed is swept on authorized_at
 * instead — a signature nobody is working on is exactly the thing that must
 * not sit armed indefinitely.
 */
export async function storeAuthorization(
  supabase: SupabaseClient,
  {
    intentId,
    buyerWallet,
    signedTx,
    nonceAccount,
    nonceAuthority,
  }: {
    intentId: string;
    buyerWallet: string;
    signedTx: string;
    nonceAccount: string;
    nonceAuthority: string;
  },
): Promise<boolean> {
  const sealed = encryptString(signedTx, aadFor(intentId));
  const now = nowIso();

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      authorized_at: now,
      nonce_account: nonceAccount,
      nonce_authority: nonceAuthority,
      authorized_tx_ct: sealed.encrypted,
      authorized_tx_iv: sealed.iv,
      authorized_tx_tag: sealed.authTag,
      authorized_tx_kid: sealed.kid ?? "field-v1",
      status: "generating",
      updated_at: now,
    })
    .eq("id", intentId)
    .eq("buyer_wallet", buyerWallet)
    // Only a fresh quote may be authorised. Re-signing something already
    // captured or voided must not resurrect it.
    .is("authorized_at", null)
    .is("captured_at", null)
    .is("voided_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[payments/auth] could not store the authorisation:", error.message);
    return false;
  }
  return Boolean(data);
}

/**
 * Claim the right to broadcast, and get the transaction to broadcast.
 *
 * null means we lost: something voided this authorisation first, and the nonce
 * it was built on is already spent. Broadcasting anyway would fail on-chain,
 * but the caller must not even try — a null here is the signal that the image
 * has to be handed over unpaid, which is the correct way for this to fail.
 *
 * Order matters at the call site: capture AFTER the image is durably stored.
 * The window between the two is one round-trip either way, and it should point
 * at losing our fee rather than losing the buyer's image.
 */
export async function captureAuthorization(
  supabase: SupabaseClient,
  intentId: string,
): Promise<HeldAuthorization | null> {
  const now = nowIso();
  const { data, error } = await supabase
    .from(TABLE)
    .update({ captured_at: now, status: "captured", updated_at: now })
    .eq("id", intentId)
    .not("authorized_at", "is", null)
    .is("captured_at", null)
    .is("voided_at", null)
    .select("id, authorized_tx_ct, authorized_tx_iv, authorized_tx_tag, authorized_tx_kid, nonce_account, total_micro")
    .maybeSingle();

  if (error) {
    console.error("[payments/auth] capture failed:", error.message);
    return null;
  }
  if (!data) return null;

  return {
    intentId,
    signedTx: decryptString(
      {
        encrypted: data.authorized_tx_ct,
        iv: data.authorized_tx_iv,
        authTag: data.authorized_tx_tag,
        kid: data.authorized_tx_kid,
      },
      aadFor(intentId),
    ),
    nonceAccount: data.nonce_account,
    totalMicro: Number(data.total_micro),
  };
}

/**
 * Claim the right to flush the nonce, and get the nonce to flush.
 *
 * null means we lost — capture got there first, which can only happen if the
 * image was delivered. Nothing to undo.
 *
 * The DB write comes first and the on-chain advance second: a flushed nonce
 * with an unflushed row would let the sweeper try again forever, whereas a
 * flushed row with a live nonce is caught by the sweep. Both orders leak
 * something; only this one leaks a retry.
 */
export async function voidAuthorization(
  supabase: SupabaseClient,
  intentId: string,
  reason: VoidReason,
): Promise<{ intentId: string; nonceAccount: string | null } | null> {
  const now = nowIso();
  const { data, error } = await supabase
    .from(TABLE)
    .update({ voided_at: now, void_reason: reason, status: "voided", updated_at: now })
    .eq("id", intentId)
    .not("authorized_at", "is", null)
    .is("captured_at", null)
    .is("voided_at", null)
    .select("id, nonce_account")
    .maybeSingle();

  if (error) {
    console.error("[payments/auth] void failed:", error.message);
    return null;
  }
  if (!data) return null;
  return { intentId, nonceAccount: data.nonce_account };
}

/**
 * Void a row ONLY IF it is still stale at the moment of the write.
 *
 * The predicate is repeated here verbatim, OR branch included, so selection
 * and execution agree. A NULL consumed_at does not satisfy `lt`, which is why
 * the second branch cannot be dropped: an authorisation that was signed and
 * never claimed would otherwise be immortal.
 *
 * With consumed_at this is belt and braces rather than a fix — the timestamp
 * is written once by claimForGeneration and never moves, so the SELECT and the
 * UPDATE cannot disagree about it. Under the heartbeat they could, and did:
 * a beat landing between the two was ignored by the write, which voided live
 * authorisations and shipped their images unpaid.
 *
 * voidAuthorization stays deadline-blind on purpose: an explicit void
 * (provider failed, buyer cancelled) is a decision, not an observation, and
 * must not be second-guessed by a timestamp.
 */
async function voidIfStale(
  supabase: SupabaseClient,
  intentId: string,
  cutoff: string,
): Promise<{ intentId: string; nonceAccount: string | null } | null> {
  const now = nowIso();
  const { data, error } = await supabase
    .from(TABLE)
    .update({ voided_at: now, void_reason: "abandoned" as VoidReason, status: "voided", updated_at: now })
    .eq("id", intentId)
    .not("authorized_at", "is", null)
    .is("captured_at", null)
    .is("voided_at", null)
    .or(`consumed_at.lt.${cutoff},and(consumed_at.is.null,authorized_at.lt.${cutoff})`)
    .select("id, nonce_account")
    .maybeSingle();

  if (error) {
    console.error("[payments/auth] stale void failed:", error.message);
    return null;
  }
  if (!data) return null;
  return { intentId, nonceAccount: data.nonce_account as string | null };
}

/**
 * Void every intent that was prepared at /authorize and never signed.
 *
 * /authorize creates a nonce account (about 0.00145 SOL of rent from the fee
 * payer) before the buyer sees the wallet popup. A buyer who cancels there
 * never reaches /submit, so authorized_at stays null and sweepAbandoned, which
 * only looks at signed rows, never saw it: the account stayed open and its
 * rent with it, once per cancelled checkout. Same cutoff as the signed sweep,
 * re-checked at the moment of the write so a /submit that lands in between
 * wins and is never voided.
 */
export async function sweepUnsubmitted(
  supabase: SupabaseClient,
  limit = 20,
): Promise<{ intentId: string; nonceAccount: string | null }[]> {
  const cutoff = staleCutoff();
  const { data, error } = await supabase
    .from(TABLE)
    .select("id")
    .eq("status", "building")
    .not("nonce_account", "is", null)
    .is("authorized_at", null)
    .is("captured_at", null)
    .is("voided_at", null)
    .lt("updated_at", cutoff)
    .limit(limit);
  if (error) {
    console.warn("[payments/auth] unsubmitted sweep failed:", error.message);
    return [];
  }

  const flushed: { intentId: string; nonceAccount: string | null }[] = [];
  for (const row of data ?? []) {
    const now = nowIso();
    const { data: won } = await supabase
      .from(TABLE)
      .update({ voided_at: now, void_reason: "abandoned" as VoidReason, status: "voided", updated_at: now })
      .eq("id", row.id as string)
      .eq("status", "building")
      .is("authorized_at", null)
      .is("voided_at", null)
      .lt("updated_at", cutoff)
      .select("id, nonce_account")
      .maybeSingle();
    if (won) flushed.push({ intentId: row.id as string, nonceAccount: won.nonce_account as string | null });
  }
  return flushed;
}

/**
 * Void every authorisation whose worker went quiet.
 *
 * Runs from the five-minute cron (/api/cron/sweep-payments), and each new
 * generation sweeps a handful first — the same pattern generation_slots
 * uses.
 *
 * Each row is voided through voidIfStale rather than in one bulk UPDATE, so
 * the staleness is re-checked at the moment of the write. Under the heartbeat
 * that recheck was the difference between correct and catastrophic; with
 * consumed_at it is cheap insurance, because the value cannot change between
 * the two statements.
 */
export async function sweepAbandoned(
  supabase: SupabaseClient,
  limit = 20,
): Promise<{ intentId: string; nonceAccount: string | null }[]> {
  const cutoff = staleCutoff();
  const { data, error } = await supabase
    .from(TABLE)
    .select("id")
    .not("authorized_at", "is", null)
    .is("captured_at", null)
    .is("voided_at", null)
    // The null branch is the normal case, not defence in depth: consumed_at
    // is NULL for every authorisation that was signed and never claimed, and
    // those are swept on how long ago they were authorised.
    .or(`consumed_at.lt.${cutoff},and(consumed_at.is.null,authorized_at.lt.${cutoff})`)
    .limit(limit);

  if (error) {
    console.warn("[payments/auth] sweep failed:", error.message);
    return [];
  }

  const flushed: { intentId: string; nonceAccount: string | null }[] = [];
  for (const row of data ?? []) {
    // Re-checked at write time against the same cutoff the SELECT used.
    const won = await voidIfStale(supabase, row.id as string, cutoff);
    if (won) flushed.push(won);
  }
  return flushed;
}
