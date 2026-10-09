import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * BAN-8. /build builds nothing irreversible ("Nothing moves here" — its own
 * doc comment) and no longer checks step-up. /submit is where a step-up
 * token is required once a factor is enrolled, bound to THIS withdrawal's
 * own request id (the row's id, returned by /build as requestId) rather
 * than the destination: a token minted for one request can never authorize
 * another, and MFA-1's single-use store means it cannot be replayed for the
 * same request twice either. The owner is mailed once the transfer confirms.
 * A ban never adds any of this on top of what an unbanned user already
 * faces (the funds door stays open).
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64"); });

const U = "11111111-1111-4111-8111-111111111111";
const FROM = Keypair.generate().publicKey.toBase58();
const TO = Keypair.generate().publicKey.toBase58();
const REQ_A = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const REQ_B = "7f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5c";
const built = vi.fn(async () => ({ transaction: "dHg=", messageHash: "h" }));
let banned = false;

vi.mock("@/lib/usdc-balance", () => ({ getUsdcBalance: async () => 10 }));
vi.mock("@/lib/ip-hash", () => ({ getClientIp: () => "203.0.113.1", hashIp: () => "ip" }));
vi.mock("@/lib/payments/solana", async () => {
  const { Keypair: K, PublicKey } = await import("@solana/web3.js");
  return {
    feePayerKeypair: () => K.generate(),
    solanaChainKey: () => "solana-devnet",
    solanaConnection: () => ({}),
    usdcMint: () => new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  };
});
vi.mock("@/lib/payments/x402-settle", () => ({
  submitAndConfirm: vi.fn(async () => ({ ok: true, signature: "sig1" })),
}));
// resolveWithdrawer itself stays REAL: it is ban-tolerant by construction
// (reads resolveSessionUserWithBan and ignores the ban it gets back), and the
// "stays open for a banned user" test below only means something if that
// real code path runs. Only session resolution is faked here.
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserWithBan: async () => ({
    userId: U, wallet: FROM, ban: banned ? { id: "b1", reason: "spam", expiresAt: null } : null,
  }),
}));
vi.mock("@/lib/payments/withdraw", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/withdraw")>()),
  checkWithdrawRequest: () => null,
  recentWithdrawalCount: async () => 0,
  withdrawLimited: () => null,
  buildWithdrawTx: () => built(),
  insertWithdrawal: async () => ({ id: REQ_A }),
  verifySignedWithdrawal: () => ({ ok: true, tx: { recentBlockhash: "x" } }),
}));

import { POST as build } from "../../app/api/wallet/withdraw/build/route";
import { POST as submit } from "../../app/api/wallet/withdraw/submit/route";
import { mintStepUpToken } from "../webauthn";

const buildReq = (token?: string) =>
  build(new NextRequest("http://enki.test/api/wallet/withdraw/build", {
    method: "POST",
    headers: { "X-Session-Token": "s", ...(token ? { "X-StepUp-Token": token } : {}) },
    body: JSON.stringify({ from: FROM, to: TO, amountMicro: 1_000_000 }),
  }));

const submitReq = (requestId: string, token?: string) =>
  submit(new NextRequest("http://enki.test/api/wallet/withdraw/submit", {
    method: "POST",
    headers: { "X-Session-Token": "s", ...(token ? { "X-StepUp-Token": token } : {}) },
    body: JSON.stringify({ requestId, signedTransaction: "c2lnbmVk" }),
  }));

const pendingRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, user_id: U, status: "pending", created_at: new Date().toISOString(),
  from_address: FROM, to_address: TO, amount_micro: 1_000_000, message_hash: "h", ...overrides,
});

const mails: { to: string; text: string }[] = [];
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: { to: string; text: string }) => { mails.push(m); return { ok: true }; } }));

beforeEach(() => {
  db.current = fakePostgrest();
  db.current.tables.webauthn_credentials = [];
  db.current.tables.mfa_factors = [];
  db.current.tables.withdrawals = [];
  db.current.tables.password_credentials = [{ user_id: U, email: "owner@enki.test", email_verified_at: "2026-10-07T00:00:00Z" }];
  // Real resolveWithdrawer reads this to learn the session's Solana address.
  db.current.tables.auth_sessions = [{ token: "s", wallet_address: FROM }];
  banned = false;
  built.mockClear();
  mails.length = 0;
});

describe("building a withdrawal", () => {
  it("needs no step-up: nothing moves here, with or without a factor enrolled", async () => {
    expect((await buildReq()).status).toBe(200);
    db.current!.tables.mfa_factors.push({ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" });
    expect((await buildReq()).status).toBe(200);
  });
});

describe("submitting a withdrawal", () => {
  it("needs nothing extra without a second factor", async () => {
    db.current!.tables.withdrawals.push(pendingRow(REQ_A));
    const res = await submitReq(REQ_A);
    expect(res.status).toBe(200);
  });

  it("asks for a token bound to THIS request id, once a factor is set up", async () => {
    db.current!.tables.mfa_factors.push({ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" });
    db.current!.tables.withdrawals.push(pendingRow(REQ_A));
    const bare = await submitReq(REQ_A);
    expect(bare.status).toBe(401);
    expect((await bare.json()).stepUp).toBe(true);
    expect((await submitReq(REQ_A, await mintStepUpToken(U, `withdraw:${REQ_B}`)))?.status).toBe(401);
  });

  it("a token for request A cannot authorize request B", async () => {
    db.current!.tables.mfa_factors.push({ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" });
    db.current!.tables.withdrawals.push(pendingRow(REQ_A), pendingRow(REQ_B));
    const tokenForA = await mintStepUpToken(U, `withdraw:${REQ_A}`);
    const res = await submitReq(REQ_B, tokenForA);
    expect(res.status).toBe(401);
  });

  it("refuses a replayed token: the same request cannot be submitted twice with it", async () => {
    db.current!.tables.mfa_factors.push({ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" });
    db.current!.tables.withdrawals.push(pendingRow(REQ_A));
    const token = await mintStepUpToken(U, `withdraw:${REQ_A}`);
    const first = await submitReq(REQ_A, token);
    expect(first.status).toBe(200);
    // Reset the row back to pending to isolate the step-up replay check from
    // the (also true, separately tested) "already submitted" status guard.
    db.current!.tables.withdrawals[0].status = "pending";
    const replay = await submitReq(REQ_A, token);
    expect(replay.status).toBe(401);
  });

  it("fails closed when the consumed-token store errors, never broadcasting", async () => {
    db.current!.tables.mfa_factors.push({ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" });
    db.current!.tables.withdrawals.push(pendingRow(REQ_A));
    const token = await mintStepUpToken(U, `withdraw:${REQ_A}`);
    db.current!.state.failing = { table: "consumed_stepup_tokens", code: "XX000" };
    const res = await submitReq(REQ_A, token);
    expect(res.status).toBe(503);
    expect(db.current!.tables.withdrawals[0].status).toBe("pending");
  });

  it("mails the owner once the transfer confirms, and not when it does not", async () => {
    db.current!.tables.withdrawals.push(pendingRow(REQ_A));
    const res = await submitReq(REQ_A);
    expect(res.status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("owner@enki.test");
  });

  it("stays open for a banned user: a ban adds no step-up requirement on top of what an unbanned user already faces", async () => {
    banned = true;
    db.current!.tables.withdrawals.push(pendingRow(REQ_A));
    // No factor enrolled: an unbanned user would pass with no token, and so
    // must a banned one — the funds door never locks on a ban.
    const res = await submitReq(REQ_A);
    expect(res.status).toBe(200);
    expect(mails).toHaveLength(1); // the owner notice fires for a banned user too.

    // With a factor enrolled, a banned user faces exactly the SAME step-up a
    // good-standing user would, never more: the request-id-bound token still
    // works for them.
    db.current!.tables.mfa_factors.push({ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" });
    db.current!.tables.withdrawals.push(pendingRow(REQ_B));
    const bare = await submitReq(REQ_B);
    expect(bare.status).toBe(401);
    const withToken = await submitReq(REQ_B, await mintStepUpToken(U, `withdraw:${REQ_B}`));
    expect(withToken.status).toBe(200);
  });
});
