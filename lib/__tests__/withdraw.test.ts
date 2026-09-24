import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction, type Connection, type PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  WITHDRAW_CU_LIMIT,
  WITHDRAW_HOURLY_LIMIT,
  WITHDRAW_TTL_MS,
  buildWithdrawTx,
  checkWithdrawRequest,
  insertWithdrawal,
  isExpired,
  isNotMigrated,
  parseAmountMicro,
  parsePubkey,
  recentWithdrawalCount,
  resolveWithdrawer,
  transactionDead,
  verifySignedWithdrawal,
  withdrawLimited,
} from "@/lib/payments/withdraw";

const feePayer = Keypair.generate();
const user = Keypair.generate();
const recipient = Keypair.generate();
const mint = Keypair.generate().publicKey;
const UUID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";

/** Same postgrest-shaped fake as session-user.test.ts, plus the count shape; records the filters used. */
function chain(result: { data?: unknown; error?: unknown; count?: number | null }, calls: string[] = []) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gt", "gte", "is", "or", "not", "in", "order", "limit"]) {
    c[m] = (...args: unknown[]) => { calls.push([m, ...args.map(String)].join(" ")); return c; };
  }
  c.maybeSingle = () => Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null }).then(res, rej);
  return c;
}
function fakeSupabase(
  byTable: Record<string, { data?: unknown; error?: unknown; count?: number | null }>,
  rpc: { data?: unknown; error?: unknown } = {},
) {
  const calls: string[] = [];
  const client = {
    from: vi.fn((table: string) => chain(byTable[table] ?? {}, calls)),
    rpc: vi.fn(() => Promise.resolve({ data: rpc.data ?? null, error: rpc.error ?? null })),
  };
  return { client: client as unknown as SupabaseClient, calls, rpc: client.rpc };
}

/** An RPC that answers the reads /build needs and nothing else. By default the recipient holds a USDC account. */
function fakeConnection(
  fees: { slot: number; prioritizationFee: number }[] = [],
  destOwner: PublicKey | null = TOKEN_PROGRAM_ID,
) {
  return {
    getRecentPrioritizationFees: async () => fees,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    getAccountInfo: async () => (destOwner ? { owner: destOwner, lamports: 2_039_280, data: Buffer.alloc(165) } : null),
  } as unknown as Connection;
}

async function build(amountMicro = 1_000_000, fees?: { slot: number; prioritizationFee: number }[], destOwner?: PublicKey | null) {
  const built = await buildWithdrawTx(fakeConnection(fees, destOwner), {
    feePayer, from: user.publicKey, to: recipient.publicKey, mint, amountMicro,
  });
  if ("status" in built) throw new Error(`refused: ${built.error}`);
  return built;
}

/** What the wallet does: add the user's signature, keep the fee payer's. */
function userSigns(transaction: string): string {
  const tx = Transaction.from(Buffer.from(transaction, "base64"));
  tx.partialSign(user);
  return tx.serialize().toString("base64");
}

const expected = () => ({ from: user.publicKey, feePayer: feePayer.publicKey });
const request = { to: recipient.publicKey, from: user.publicKey, fromClaimed: user.publicKey.toBase58(), feePayer: feePayer.publicKey };

describe("request validation", () => {
  it("rejects anything that is not an on-curve base58 public key", () => {
    expect(parsePubkey("not-a-key")).toBeNull();
    expect(parsePubkey(42)).toBeNull();
    // A token account is a PDA — sending to it would strand the funds.
    expect(parsePubkey(getAssociatedTokenAddressSync(mint, user.publicKey).toBase58())).toBeNull();
    expect(parsePubkey(recipient.publicKey.toBase58())?.equals(recipient.publicKey)).toBe(true);
  });

  it("refuses a bad recipient address", () => {
    const r = checkWithdrawRequest({ ...request, to: parsePubkey("nope"), amountMicro: 1, balanceMicro: 5 });
    expect(r?.status).toBe(400);
    expect(r?.error).toMatch(/address/);
  });

  it("refuses sending to the user's own wallet", () => {
    const r = checkWithdrawRequest({ ...request, to: user.publicKey, amountMicro: 1, balanceMicro: 5 });
    expect(r?.status).toBe(400);
    expect(r?.error).toMatch(/own wallet/);
  });

  it("refuses sending to the fee payer", () => {
    const r = checkWithdrawRequest({ ...request, to: feePayer.publicKey, amountMicro: 1, balanceMicro: 5 });
    expect(r?.status).toBe(400);
    expect(r?.error).toMatch(/not accepted/);
  });

  it("refuses when the wallet the client shows is not the session's, before any row exists", () => {
    const stale = Keypair.generate().publicKey.toBase58();
    expect(checkWithdrawRequest({ ...request, fromClaimed: stale, amountMicro: 1, balanceMicro: 5 })).toMatchObject({ status: 400, code: "FROM_MISMATCH" });
    expect(checkWithdrawRequest({ ...request, fromClaimed: undefined, amountMicro: 1, balanceMicro: 5 })).toMatchObject({ status: 400, code: "FROM_MISMATCH" });
    expect(checkWithdrawRequest({ ...request, amountMicro: 1, balanceMicro: 5 })).toBeNull();
  });

  it("answers INSUFFICIENT_FUNDS when the amount exceeds the balance", () => {
    expect(checkWithdrawRequest({ ...request, amountMicro: 6, balanceMicro: 5 })).toMatchObject({ status: 400, code: "INSUFFICIENT_FUNDS" });
    expect(checkWithdrawRequest({ ...request, amountMicro: 5, balanceMicro: 5 })).toBeNull();
  });

  it("answers INSUFFICIENT_FUNDS for `all` on an empty balance: never a zero transfer for the fee payer to co-sign", () => {
    expect(checkWithdrawRequest({ ...request, amountMicro: 0, balanceMicro: 0 })).toMatchObject({ status: 400, code: "INSUFFICIENT_FUNDS" });
  });

  it("accepts only positive safe integers as the amount", () => {
    expect(parseAmountMicro("1500000")).toBe(1_500_000);
    expect(parseAmountMicro(2)).toBe(2);
    for (const bad of [0, -1, 1.5, "1.5", "abc", "", null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
      expect(parseAmountMicro(bad)).toBeNull();
    }
    const r = checkWithdrawRequest({ ...request, amountMicro: null, balanceMicro: 5 });
    expect(r?.status).toBe(400);
  });
});

describe("hourly limit (database backed)", () => {
  it("limits the 6th request within the hour and lets the 5th through", async () => {
    const atLimit = fakeSupabase({ withdrawals: { count: WITHDRAW_HOURLY_LIMIT } });
    expect(withdrawLimited(await recentWithdrawalCount(atLimit.client, UUID))).toMatchObject({ status: 429 });
    const below = fakeSupabase({ withdrawals: { count: WITHDRAW_HOURLY_LIMIT - 1 } });
    expect(withdrawLimited(await recentWithdrawalCount(below.client, UUID))).toBeNull();
  });

  it("counts every row of the hour, expired and failed included: the fee payer signed on /build", async () => {
    const s = fakeSupabase({ withdrawals: { count: WITHDRAW_HOURLY_LIMIT } });
    await recentWithdrawalCount(s.client, UUID);
    expect(s.calls.some((c) => /status/.test(c))).toBe(false);
    expect(s.calls.some((c) => /^gte created_at/.test(c))).toBe(true);
  });

  it("inserts through withdrawal_begin with the limit, and turns its RAISE into the 429", async () => {
    const row = { userId: UUID, from: "f", to: "t", amountMicro: 1, mint: "m", messageHash: "h", ipHash: null };
    const ok = fakeSupabase({}, { data: UUID });
    expect(await insertWithdrawal(ok.client, row)).toEqual({ id: UUID });
    expect(ok.rpc).toHaveBeenCalledWith("withdrawal_begin", expect.objectContaining({ p_user: UUID, p_limit: WITHDRAW_HOURLY_LIMIT }));

    const limited = fakeSupabase({}, { error: { code: "P0001", message: "WITHDRAW_LIMIT" } });
    expect(await insertWithdrawal(limited.client, row)).toMatchObject({ status: 429, code: "RATE_LIMITED" });

    const other = { code: "23514", message: "violates check constraint" };
    await expect(insertWithdrawal(fakeSupabase({}, { error: other }).client, row)).rejects.toBe(other);
  });

  it("surfaces the missing table or function so the route can answer 503", async () => {
    const missing = { code: "PGRST205", message: "Could not find the table 'public.withdrawals' in the schema cache" };
    await expect(recentWithdrawalCount(fakeSupabase({ withdrawals: { error: missing } }).client, UUID)).rejects.toBe(missing);
    expect(isNotMigrated(missing)).toBe(true);
    // The code and the message each suffice on their own: PostgREST keeps the code, the wording may drift.
    expect(isNotMigrated({ code: "PGRST202", message: "" })).toBe(true);
    expect(isNotMigrated({ message: "Could not find the function public.withdrawal_begin" })).toBe(true);
    expect(isNotMigrated({ code: "42501", message: "permission denied" })).toBe(false);
  });
});

describe("session resolution", () => {
  it("resolves a BANNED wallet session — a ban locks the marketplace, never the wallet", async () => {
    const { client } = fakeSupabase({
      auth_sessions: { data: { wallet_address: user.publicKey.toBase58() } },
      user_wallets: { data: { user_id: UUID, address: user.publicKey.toBase58() } },
      bans: { data: [{ id: "b1", reason: "spam", expires_at: null }] },
    });
    await expect(resolveWithdrawer(client, "tok")).resolves.toEqual({ userId: UUID, from: user.publicKey.toBase58() });
  });

  it("takes the primary Solana wallet when the session stores the user UUID (email login)", async () => {
    const { client } = fakeSupabase({
      auth_sessions: { data: { wallet_address: UUID } },
      user_wallets: { data: { user_id: UUID, address: user.publicKey.toBase58() } },
      bans: { data: [] },
    });
    await expect(resolveWithdrawer(client, "tok")).resolves.toEqual({ userId: UUID, from: user.publicKey.toBase58() });
  });

  it("is nobody without a valid session", async () => {
    await expect(resolveWithdrawer(fakeSupabase({}).client, "tok")).resolves.toBeNull();
    await expect(resolveWithdrawer(fakeSupabase({}).client, null)).resolves.toBeNull();
  });
});

describe("the built transaction", () => {
  it("is co-signed by the fee payer, spends only the user's tokens, and verifies once the user signs", async () => {
    const built = await build(250_000, [{ slot: 1, prioritizationFee: 500 }, { slot: 2, prioritizationFee: 700 }]);
    const tx = Transaction.from(Buffer.from(built.transaction, "base64"));
    expect(tx.feePayer?.equals(feePayer.publicKey)).toBe(true);
    // ComputeBudget limit, ComputeBudget price, TransferChecked.
    expect(tx.instructions).toHaveLength(3);
    const transfer = tx.instructions[2];
    expect(transfer.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(transfer.keys[3].pubkey.equals(user.publicKey)).toBe(true);
    expect(transfer.keys[2].pubkey.equals(getAssociatedTokenAddressSync(mint, recipient.publicKey))).toBe(true);
    expect(transfer.data.readBigUInt64LE(1)).toBe(BigInt(250_000));
    // The fee payer pays the network fee and nothing else: it is in no instruction at all.
    expect(tx.instructions.some((ix) => ix.keys.some((k) => k.pubkey.equals(feePayer.publicKey)))).toBe(false);

    const verified = verifySignedWithdrawal(userSigns(built.transaction), { messageHash: built.messageHash, ...expected() });
    expect(verified.ok).toBe(true);
  });

  it("caps the compute units so the priority fee cannot be priced on the 200k default", async () => {
    const tx = Transaction.from(Buffer.from((await build()).transaction, "base64"));
    const limit = tx.instructions[0];
    // SetComputeUnitLimit: discriminator 2, then u32 LE units.
    expect(limit.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(limit.data[0]).toBe(2);
    expect(limit.data.readUInt32LE(1)).toBe(WITHDRAW_CU_LIMIT);
    expect(WITHDRAW_CU_LIMIT).toBeLessThanOrEqual(60_000);
  });

  it("skips the priority fee instruction when the fee market is idle", async () => {
    const tx = Transaction.from(Buffer.from((await build(1, [])).transaction, "base64"));
    expect(tx.instructions).toHaveLength(2);
  });

  it("refuses a recipient without a USDC account instead of paying its rent", async () => {
    const missing = await buildWithdrawTx(fakeConnection([], null), { feePayer, from: user.publicKey, to: recipient.publicKey, mint, amountMicro: 1 });
    expect(missing).toMatchObject({ status: 400, code: "NO_RECIPIENT_ACCOUNT" });
    // Lamports sent to the ATA address make it exist as a SYSTEM account: still no token account.
    const system = await buildWithdrawTx(fakeConnection([], SystemProgram.programId), { feePayer, from: user.publicKey, to: recipient.publicKey, mint, amountMicro: 1 });
    expect(system).toMatchObject({ status: 400, code: "NO_RECIPIENT_ACCOUNT" });
  });
});

describe("submit verification", () => {
  it("rejects a fully signed transaction from a DIFFERENT build (altered message)", async () => {
    const a = await build(1_000_000);
    const b = await build(2_000_000);
    const signedA = userSigns(a.transaction);
    expect(verifySignedWithdrawal(signedA, { messageHash: a.messageHash, ...expected() }).ok).toBe(true);
    const swapped = verifySignedWithdrawal(signedA, { messageHash: b.messageHash, ...expected() });
    expect(swapped).toMatchObject({ ok: false, error: expect.stringMatching(/differs/) });
  });

  it("rejects the transaction when the user's signature is missing", async () => {
    const built = await build();
    const r = verifySignedWithdrawal(built.transaction, { messageHash: built.messageHash, ...expected() });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/not fully signed/) });
  });

  it("rejects a signer set that is not exactly the wallet and the fee payer", async () => {
    const built = await build();
    const stranger = Keypair.generate();
    const r = verifySignedWithdrawal(userSigns(built.transaction), { messageHash: built.messageHash, from: stranger.publicKey, feePayer: feePayer.publicKey });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/signers/) });
  });

  it("rejects garbage", () => {
    expect(verifySignedWithdrawal("bm90IGEgdHg=", { messageHash: "x", ...expected() }).ok).toBe(false);
  });

  it("expires a row older than the signing window, which is no longer than a blockhash lives", () => {
    const now = Date.now();
    expect(WITHDRAW_TTL_MS).toBeLessThanOrEqual(60_000);
    expect(isExpired(new Date(now - WITHDRAW_TTL_MS - 1_000).toISOString(), now)).toBe(true);
    expect(isExpired(new Date(now - WITHDRAW_TTL_MS + 1_000).toISOString(), now)).toBe(false);
  });

  it("calls a timed out transaction dead only when the chain says its blockhash expired", async () => {
    const tx = Transaction.from(Buffer.from((await build()).transaction, "base64"));
    const conn = (value: boolean | Error) => ({
      isBlockhashValid: async () => { if (value instanceof Error) throw value; return { value }; },
    }) as unknown as Connection;
    expect(await transactionDead(conn(false), tx)).toBe(true);
    expect(await transactionDead(conn(true), tx)).toBe(false);
    // An RPC error proves nothing; the user keeps the signature to check.
    expect(await transactionDead(conn(new Error("429")), tx)).toBe(false);
  });
});
