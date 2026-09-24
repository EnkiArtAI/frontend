import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Keypair, Transaction, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  WITHDRAW_HOURLY_LIMIT,
  WITHDRAW_TTL_MS,
  buildWithdrawTx,
  checkWithdrawRequest,
  isExpired,
  isTableMissing,
  parseAmountMicro,
  parsePubkey,
  recentWithdrawalCount,
  resolveWithdrawer,
  verifySignedWithdrawal,
  withdrawLimited,
} from "@/lib/payments/withdraw";

const feePayer = Keypair.generate();
const user = Keypair.generate();
const recipient = Keypair.generate();
const mint = Keypair.generate().publicKey;
const UUID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";

/** Same postgrest-shaped fake as session-user.test.ts, plus the count shape. */
function chain(result: { data?: unknown; error?: unknown; count?: number | null }) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gt", "gte", "is", "or", "not", "order", "limit"]) c[m] = () => c;
  c.maybeSingle = () => Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null }).then(res, rej);
  return c;
}
function fakeSupabase(byTable: Record<string, { data?: unknown; error?: unknown; count?: number | null }>) {
  return { from: vi.fn((table: string) => chain(byTable[table] ?? {})) } as unknown as SupabaseClient;
}

/** An RPC that answers the two reads /build needs and nothing else. */
function fakeConnection(fees: { slot: number; prioritizationFee: number }[] = []) {
  return {
    getRecentPrioritizationFees: async () => fees,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
  } as unknown as Connection;
}

async function build(amountMicro = 1_000_000, fees?: { slot: number; prioritizationFee: number }[]) {
  return buildWithdrawTx(fakeConnection(fees), {
    feePayer, from: user.publicKey, to: recipient.publicKey, mint, amountMicro,
  });
}

/** What the wallet does: add the user's signature, keep the fee payer's. */
function userSigns(transaction: string): string {
  const tx = Transaction.from(Buffer.from(transaction, "base64"));
  tx.partialSign(user);
  return tx.serialize().toString("base64");
}

const expected = () => ({ from: user.publicKey, feePayer: feePayer.publicKey });

describe("request validation", () => {
  it("rejects anything that is not an on-curve base58 public key", () => {
    expect(parsePubkey("not-a-key")).toBeNull();
    expect(parsePubkey(42)).toBeNull();
    // A token account is a PDA — sending to it would strand the funds.
    expect(parsePubkey(getAssociatedTokenAddressSync(mint, user.publicKey).toBase58())).toBeNull();
    expect(parsePubkey(recipient.publicKey.toBase58())?.equals(recipient.publicKey)).toBe(true);
  });

  it("refuses a bad recipient address", () => {
    const r = checkWithdrawRequest({ to: parsePubkey("nope"), from: user.publicKey, feePayer: feePayer.publicKey, amountMicro: 1, balanceMicro: 5 });
    expect(r?.status).toBe(400);
    expect(r?.error).toMatch(/address/);
  });

  it("refuses sending to the user's own wallet", () => {
    const r = checkWithdrawRequest({ to: user.publicKey, from: user.publicKey, feePayer: feePayer.publicKey, amountMicro: 1, balanceMicro: 5 });
    expect(r?.status).toBe(400);
    expect(r?.error).toMatch(/own wallet/);
  });

  it("refuses sending to the fee payer", () => {
    const r = checkWithdrawRequest({ to: feePayer.publicKey, from: user.publicKey, feePayer: feePayer.publicKey, amountMicro: 1, balanceMicro: 5 });
    expect(r?.status).toBe(400);
    expect(r?.error).toMatch(/not accepted/);
  });

  it("answers INSUFFICIENT_FUNDS when the amount exceeds the balance", () => {
    const base = { to: recipient.publicKey, from: user.publicKey, feePayer: feePayer.publicKey };
    expect(checkWithdrawRequest({ ...base, amountMicro: 6, balanceMicro: 5 })).toMatchObject({ status: 400, code: "INSUFFICIENT_FUNDS" });
    expect(checkWithdrawRequest({ ...base, amountMicro: 5, balanceMicro: 5 })).toBeNull();
  });

  it("accepts only positive safe integers as the amount", () => {
    expect(parseAmountMicro("1500000")).toBe(1_500_000);
    expect(parseAmountMicro(2)).toBe(2);
    for (const bad of [0, -1, 1.5, "1.5", "abc", "", null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
      expect(parseAmountMicro(bad)).toBeNull();
    }
    const r = checkWithdrawRequest({ to: recipient.publicKey, from: user.publicKey, feePayer: feePayer.publicKey, amountMicro: null, balanceMicro: 5 });
    expect(r?.status).toBe(400);
  });
});

describe("hourly limit (database backed)", () => {
  it("limits the 6th request within the hour and lets the 5th through", async () => {
    const atLimit = fakeSupabase({ withdrawals: { count: WITHDRAW_HOURLY_LIMIT } });
    expect(withdrawLimited(await recentWithdrawalCount(atLimit, UUID))).toMatchObject({ status: 429 });
    const below = fakeSupabase({ withdrawals: { count: WITHDRAW_HOURLY_LIMIT - 1 } });
    expect(withdrawLimited(await recentWithdrawalCount(below, UUID))).toBeNull();
  });

  it("surfaces the missing table so the route can answer 503", async () => {
    const missing = { code: "PGRST205", message: "Could not find the table 'public.withdrawals' in the schema cache" };
    await expect(recentWithdrawalCount(fakeSupabase({ withdrawals: { error: missing } }), UUID)).rejects.toBe(missing);
    expect(isTableMissing(missing)).toBe(true);
    expect(isTableMissing({ code: "42501", message: "permission denied" })).toBe(false);
  });
});

describe("session resolution", () => {
  it("resolves a BANNED wallet session — a ban locks the marketplace, never the wallet", async () => {
    const supabase = fakeSupabase({
      auth_sessions: { data: { wallet_address: user.publicKey.toBase58() } },
      user_wallets: { data: { user_id: UUID, address: user.publicKey.toBase58() } },
      bans: { data: [{ id: "b1", reason: "spam", expires_at: null }] },
    });
    await expect(resolveWithdrawer(supabase, "tok")).resolves.toEqual({ userId: UUID, from: user.publicKey.toBase58() });
  });

  it("takes the primary Solana wallet when the session stores the user UUID (email login)", async () => {
    const supabase = fakeSupabase({
      auth_sessions: { data: { wallet_address: UUID } },
      user_wallets: { data: { user_id: UUID, address: user.publicKey.toBase58() } },
      bans: { data: [] },
    });
    await expect(resolveWithdrawer(supabase, "tok")).resolves.toEqual({ userId: UUID, from: user.publicKey.toBase58() });
  });

  it("is nobody without a valid session", async () => {
    await expect(resolveWithdrawer(fakeSupabase({}), "tok")).resolves.toBeNull();
    await expect(resolveWithdrawer(fakeSupabase({}), null)).resolves.toBeNull();
  });
});

describe("the built transaction", () => {
  it("is co-signed by the fee payer, spends only the user's tokens, and verifies once the user signs", async () => {
    const built = await build(250_000, [{ slot: 1, prioritizationFee: 500 }, { slot: 2, prioritizationFee: 700 }]);
    const tx = Transaction.from(Buffer.from(built.transaction, "base64"));
    expect(tx.feePayer?.equals(feePayer.publicKey)).toBe(true);
    // ComputeBudget price, ATA create, TransferChecked.
    expect(tx.instructions).toHaveLength(3);
    const transfer = tx.instructions[2];
    expect(transfer.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(transfer.keys[3].pubkey.equals(user.publicKey)).toBe(true);
    expect(transfer.keys[2].pubkey.equals(getAssociatedTokenAddressSync(mint, recipient.publicKey))).toBe(true);
    expect(transfer.data.readBigUInt64LE(1)).toBe(BigInt(250_000));
    // The fee payer never signs for anything but rent: not a transfer authority.
    expect(transfer.keys.some((k) => k.isSigner && k.pubkey.equals(feePayer.publicKey))).toBe(false);

    const verified = verifySignedWithdrawal(userSigns(built.transaction), { messageHash: built.messageHash, ...expected() });
    expect(verified.ok).toBe(true);
  });

  it("skips the priority fee instruction when the fee market is idle", async () => {
    const tx = Transaction.from(Buffer.from((await build(1, [])).transaction, "base64"));
    expect(tx.instructions).toHaveLength(2);
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

  it("expires a row older than the signing window", () => {
    const now = Date.now();
    expect(isExpired(new Date(now - WITHDRAW_TTL_MS - 1_000).toISOString(), now)).toBe(true);
    expect(isExpired(new Date(now - WITHDRAW_TTL_MS + 1_000).toISOString(), now)).toBe(false);
  });
});
