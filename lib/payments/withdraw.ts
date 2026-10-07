/**
 * "Send USDC": the user moves their own USDC out of their Enki wallet.
 *
 * Non-custodial, so Enki never holds the money — what it holds is the FEE
 * PAYER, and every guard here protects that key or the user from a client
 * that lies. The shape is the sponsored flow the generation checkout already
 * uses: the server builds the transaction, partial-signs as fee payer, the
 * user signs in their wallet, the server broadcasts. Three things make that
 * safe to co-sign blind:
 *
 *   1. The fee payer signature covers the MESSAGE. Any byte the client alters
 *      (amount, recipient, an extra instruction) invalidates it, and /submit
 *      also compares sha256(message) against what /build stored.
 *   2. The fee payer appears in NO instruction, the same invariant x402-settle
 *      enforces: it pays the network fee and nothing else. The recipient must
 *      already hold a USDC account, because creating one costs ~0.002 SOL of
 *      rent that the recipient can take back by closing the account — a
 *      sponsored create would turn fee-payer SOL into anyone's SOL at one
 *      micro-USDC per round.
 *   3. The hourly limit counts EVERY row, whatever its status, and is enforced
 *      inside Postgres under a per-user advisory lock (withdrawal_begin): a
 *      signature handed out on /build is exposure whether or not the client
 *      ever calls /submit, and a read-then-insert across two requests races.
 *
 * A ban does NOT block withdrawing (resolveWithdrawer): a ban locks the
 * marketplace, never the wallet — the funds are the user's, and holding them
 * hostage is not ours to do (BAN-3).
 *
 * Amounts are micro-USDC as JS numbers: bigint columns, but every plausible
 * balance (< $9e9) sits inside Number's safe range, and the ES2017 target has
 * no bigint literals.
 */
import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  type Connection,
  type Keypair,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { USDC_DECIMALS } from "@/lib/payments/authorize-tx";
import { priorityFeeMicroLamports } from "@/lib/payments/generation-pay";
import { resolveSessionUserWithBan } from "@/lib/session-user";

/**
 * A blockhash lives ~60 s (150 blocks), so the signing window is the same:
 * past it the chain refuses the transaction anyway, and EXPIRED is the
 * honest answer rather than a preflight "Blockhash not found".
 */
export const WITHDRAW_TTL_MS = 60_000;
/** Requests per user per hour, every status counted (header, point 3). */
export const WITHDRAW_HOURLY_LIMIT = 5;
/**
 * A TransferChecked needs ~6k CU; without a limit the priority fee is priced
 * on 200k CU per instruction, paid by the fee payer even when the transaction
 * fails on chain.
 */
export const WITHDRAW_CU_LIMIT = 30_000;

export type Refusal = { status: number; error: string; code?: string };

/** A base58 ed25519 public key — a wallet, not a PDA or token account. */
export function parsePubkey(value: unknown): PublicKey | null {
  if (typeof value !== "string") return null;
  try {
    const key = new PublicKey(value);
    return PublicKey.isOnCurve(key.toBytes()) ? key : null;
  } catch {
    return null;
  }
}

/** A positive integer micro amount, from a JSON number or a decimal string. */
export function parseAmountMicro(value: unknown): number | null {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Who withdraws and from where; null when the token resolves to nobody. */
export async function resolveWithdrawer(
  supabase: SupabaseClient,
  token: string | null,
): Promise<{ userId: string; from: string | null } | null> {
  // Ban tolerant on purpose (see the header): the ban is read and ignored.
  const { userId } = await resolveSessionUserWithBan(supabase, token);
  if (!userId) return null;
  return { userId, from: await sessionSolanaAddress(supabase, token!, userId) };
}

/**
 * The session's own Solana address: auth_sessions.wallet_address when it is a
 * public key (wallet sign-in), else the primary active Solana row of the user
 * (email sign-in stores the user UUID there instead).
 */
async function sessionSolanaAddress(
  supabase: SupabaseClient,
  token: string,
  userId: string,
): Promise<string | null> {
  const { data: session } = await supabase
    .from("auth_sessions")
    .select("wallet_address")
    .eq("token", token)
    .maybeSingle();
  if (parsePubkey(session?.wallet_address)) return session!.wallet_address as string;
  const { data: wallet } = await supabase
    .from("user_wallets")
    .select("address")
    .eq("user_id", userId)
    .eq("chain_family", "solana")
    .is("removed_at", null)
    .order("is_primary", { ascending: false })
    .limit(1)
    .maybeSingle();
  return parsePubkey(wallet?.address) ? (wallet!.address as string) : null;
}

export const INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS";

/** Every refusal that needs no chain or database: the request itself. */
export function checkWithdrawRequest(p: {
  to: PublicKey | null;
  from: PublicKey;
  /** The wallet the client is showing; a stale screen must not create a row. */
  fromClaimed: unknown;
  feePayer: PublicKey;
  amountMicro: number | null;
  balanceMicro: number;
}): Refusal | null {
  if (p.fromClaimed !== p.from.toBase58()) {
    return { status: 400, error: "The signed in wallet is not the one shown, reload and try again", code: "FROM_MISMATCH" };
  }
  if (!p.to) return { status: 400, error: "Recipient is not a valid Solana wallet address" };
  if (p.to.equals(p.from)) return { status: 400, error: "Recipient is your own wallet" };
  if (p.to.equals(p.feePayer)) return { status: 400, error: "Recipient is not accepted" };
  if (p.amountMicro === null) return { status: 400, error: "Amount must be a positive whole number of micro-USDC" };
  // <= 0 is the `all` path on an empty balance: the fee payer must never co-sign a zero transfer.
  if (p.amountMicro <= 0 || p.amountMicro > p.balanceMicro) {
    return { status: 400, error: "Your USDC balance does not cover this amount", code: INSUFFICIENT_FUNDS };
  }
  return null;
}

/** PostgREST's "not in schema cache" for the table or its function: the migration has not been run. */
export function isNotMigrated(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return (
    e?.code === "PGRST205" ||
    e?.code === "PGRST202" ||
    (typeof e?.message === "string" && /Could not find the (table|function)/.test(e.message))
  );
}

export const NOT_MIGRATED: Refusal = {
  status: 503,
  error: "withdrawals table not migrated",
  code: "WITHDRAWALS_NOT_MIGRATED",
};

/**
 * Rows by this user in the last hour, EVERY status: the fast path that spares
 * the chain reads and the signature when the user is plainly over the limit.
 * The guard itself is insertWithdrawal.
 */
export async function recentWithdrawalCount(
  supabase: SupabaseClient,
  userId: string,
  now = Date.now(),
): Promise<number> {
  const { count, error } = await supabase
    .from("withdrawals")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", new Date(now - 3_600_000).toISOString());
  if (error) throw error;
  return count ?? 0;
}

export function withdrawLimited(count: number): Refusal | null {
  return count >= WITHDRAW_HOURLY_LIMIT
    ? { status: 429, error: `At most ${WITHDRAW_HOURLY_LIMIT} withdrawals per hour`, code: "RATE_LIMITED" }
    : null;
}

/**
 * The row, inserted by withdrawal_begin (migrations/2026-09-24-withdrawals.sql):
 * count and insert in ONE statement under the user's advisory lock, so a
 * hundred parallel /build calls get one row each up to the limit and RAISE
 * past it. Concurrent requests on two Vercel instances share the lock too.
 */
export async function insertWithdrawal(
  supabase: SupabaseClient,
  row: { userId: string; from: string; to: string; amountMicro: number; mint: string; messageHash: string; ipHash: string | null },
): Promise<{ id: string } | Refusal> {
  const { data, error } = await supabase.rpc("withdrawal_begin", {
    p_user: row.userId,
    p_from: row.from,
    p_to: row.to,
    p_amount_micro: row.amountMicro,
    p_mint: row.mint,
    p_message_hash: row.messageHash,
    p_ip_hash: row.ipHash,
    p_limit: WITHDRAW_HOURLY_LIMIT,
  });
  if (error) {
    if (error.code === "P0001" && /WITHDRAW_LIMIT/.test(error.message)) return withdrawLimited(WITHDRAW_HOURLY_LIMIT)!;
    throw error;
  }
  return { id: String(data) };
}

export function messageHashOf(tx: Transaction): string {
  return createHash("sha256").update(tx.serializeMessage()).digest("hex");
}

export type Built = { transaction: string; messageHash: string };

/**
 * The transaction, co-signed by the fee payer and ready for the user, or the
 * refusal when the recipient holds no USDC account (header, point 2).
 * Priority fee: p75 of the cluster's recent fees, capped (generation-pay.ts),
 * skipped entirely when the fee market is idle.
 */
export async function buildWithdrawTx(
  connection: Connection,
  p: { feePayer: Keypair; from: PublicKey; to: PublicKey; mint: PublicKey; amountMicro: number },
): Promise<Built | Refusal> {
  const destAta = getAssociatedTokenAddressSync(p.mint, p.to);
  const [fees, { blockhash }, dest] = await Promise.all([
    connection.getRecentPrioritizationFees(),
    connection.getLatestBlockhash("confirmed"),
    connection.getAccountInfo(destAta),
  ]);
  // Owner check as well: lamports sent to the address make it "exist" as a
  // system account, and the transfer would then fail on chain, fee paid.
  if (!dest || !dest.owner.equals(TOKEN_PROGRAM_ID)) {
    return { status: 400, error: "Recipient has no USDC account yet", code: "NO_RECIPIENT_ACCOUNT" };
  }

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: WITHDRAW_CU_LIMIT }));
  const price = priorityFeeMicroLamports(fees);
  if (price > 0) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  tx.add(
    createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(p.mint, p.from),
      p.mint,
      destAta,
      p.from,
      BigInt(p.amountMicro),
      USDC_DECIMALS,
    ),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = p.feePayer.publicKey;
  tx.partialSign(p.feePayer);
  return {
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    messageHash: messageHashOf(tx),
  };
}

export function isExpired(createdAt: string, now = Date.now()): boolean {
  return now - new Date(createdAt).getTime() > WITHDRAW_TTL_MS;
}

/**
 * The transaction the user sent back, accepted only when it is byte-for-byte
 * the message we built, validly signed by exactly the user and the fee payer.
 */
export function verifySignedWithdrawal(
  signedBase64: string,
  expected: { messageHash: string; from: PublicKey; feePayer: PublicKey },
): { ok: true; tx: Transaction } | { ok: false; error: string } {
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(signedBase64, "base64"));
  } catch {
    return { ok: false, error: "signedTransaction is not a valid transaction" };
  }
  if (messageHashOf(tx) !== expected.messageHash) {
    return { ok: false, error: "Transaction differs from the one that was built" };
  }
  const signers = tx.signatures.map((s) => s.publicKey.toBase58());
  const wanted = [expected.from.toBase58(), expected.feePayer.toBase58()];
  if (signers.length !== 2 || !wanted.every((k) => signers.includes(k))) {
    return { ok: false, error: "Transaction signers must be exactly the wallet and the fee payer" };
  }
  // Requires ALL signers by default: a missing signature is a failure, not a skip.
  if (!tx.verifySignatures()) return { ok: false, error: "Transaction is not fully signed" };
  return { ok: true, tx };
}

/**
 * After a confirmation timeout: true only when the chain says the blockhash
 * has expired, so the transaction can never land and nothing moved. An RPC
 * error proves nothing, so it answers false and the user keeps the signature.
 */
export async function transactionDead(connection: Connection, tx: Transaction): Promise<boolean> {
  try {
    const { value } = await connection.isBlockhashValid(tx.recentBlockhash!, { commitment: "confirmed" });
    return !value;
  } catch {
    return false;
  }
}
