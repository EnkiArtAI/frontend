import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * BAN-8. Step-up is checked at /build, BEFORE buildWithdrawTx co-signs with
 * the fee payer — not at /submit. Reverted there once (2026-10-10) after an
 * independent review found a CONFIRMED bypass: once the fee payer co-signs
 * inside /build and the client's own wallet adds its signature, the bytes
 * are a fully valid, broadcastable Solana transaction that needs no further
 * round trip through us. For an externally-signed wallet (SendUsdcPanel.tsx's
 * adapterSign, 100% client-side), nothing else stands between that moment
 * and the chain — a check living only at /submit never runs for a client
 * that skips it. The decisive test below proves /build never hands out a
 * co-signed transaction without a valid, unconsumed step-up token for its
 * scope. Single-use (MFA-1's consumed_stepup_tokens) makes that same token
 * good for exactly one build, closing the replay this task was originally
 * written against — no request-id binding needed for that. The owner is
 * mailed once a withdrawal is confirmed. A ban never adds any of this on
 * top of what an unbanned user already faces (the funds door stays open).
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64"); });

const U = "11111111-1111-4111-8111-111111111111";
const FROM = Keypair.generate().publicKey.toBase58();
const TO = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const REQ_A = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
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
// Session resolution stays real-shaped via resolveSessionUserWithBan (ban
// tolerant by construction); only the wallet lookup is seeded through
// auth_sessions below, same as resolveWithdrawer's real implementation reads.
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

const buildReq = (to: string, token?: string) =>
  build(new NextRequest("http://enki.test/api/wallet/withdraw/build", {
    method: "POST",
    headers: { "X-Session-Token": "s", ...(token ? { "X-StepUp-Token": token } : {}) },
    body: JSON.stringify({ from: FROM, to, amountMicro: 1_000_000 }),
  }));

const submitReq = (requestId: string) =>
  submit(new NextRequest("http://enki.test/api/wallet/withdraw/submit", {
    method: "POST",
    headers: { "X-Session-Token": "s" },
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
  db.current.tables.auth_sessions = [{ token: "s", wallet_address: FROM }];
  banned = false;
  built.mockClear();
  mails.length = 0;
});

describe("building a withdrawal", () => {
  it("needs nothing extra without a second factor", async () => {
    expect((await buildReq(TO)).status).toBe(200);
    expect(built).toHaveBeenCalledOnce();
  });

  it(
    "DECISIVE: an externally-signed wallet can never obtain a co-signed transaction from /build " +
      "without a valid, unconsumed step-up token for its own destination — the fee payer co-sign " +
      "happens inside buildWithdrawTx, so this is the only point that can stop a direct-broadcast bypass",
    async () => {
      db.current!.tables.mfa_factors.push({ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" });

      // No token at all: refused, and the co-sign is never reached.
      const bare = await buildReq(TO);
      expect(bare.status).toBe(401);
      expect((await bare.json()).stepUp).toBe(true);
      expect(built).not.toHaveBeenCalled();

      // A token for a DIFFERENT destination: still refused, still never co-signs.
      const wrongScope = await mintStepUpToken(U, `withdraw:${OTHER}`);
      expect((await buildReq(TO, wrongScope)).status).toBe(401);
      expect(built).not.toHaveBeenCalled();

      // The right scope: only now does the co-sign happen.
      const token = await mintStepUpToken(U, `withdraw:${TO}`);
      expect((await buildReq(TO, token)).status).toBe(200);
      expect(built).toHaveBeenCalledOnce();
    },
  );

  it("a token is single-use: the SAME approval cannot authorize a second build to the same destination", async () => {
    db.current!.tables.mfa_factors.push({ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" });
    const token = await mintStepUpToken(U, `withdraw:${TO}`);
    expect((await buildReq(TO, token)).status).toBe(200);
    built.mockClear();
    const replay = await buildReq(TO, token);
    expect(replay.status).toBe(401);
    expect(built).not.toHaveBeenCalled();
  });

  it("fails closed when the consumed-token store errors, never co-signing", async () => {
    db.current!.tables.mfa_factors.push({ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" });
    const token = await mintStepUpToken(U, `withdraw:${TO}`);
    db.current!.state.failing = { table: "consumed_stepup_tokens", code: "XX000" };
    const res = await buildReq(TO, token);
    expect(res.status).toBe(503);
    expect(built).not.toHaveBeenCalled();
  });

  it("stays open for a banned user without a factor, and still gates one with a factor exactly like an unbanned user", async () => {
    banned = true;
    expect((await buildReq(TO)).status).toBe(200);

    db.current!.tables.mfa_factors.push({ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" });
    built.mockClear();
    expect((await buildReq(TO)).status).toBe(401);
    expect(built).not.toHaveBeenCalled();
    const token = await mintStepUpToken(U, `withdraw:${TO}`);
    expect((await buildReq(TO, token)).status).toBe(200);
  });
});

describe("submitting a withdrawal", () => {
  it("needs no step-up: the authorization decision already happened at /build", async () => {
    db.current!.tables.withdrawals.push(pendingRow(REQ_A));
    expect((await submitReq(REQ_A)).status).toBe(200);
  });

  it("mails the owner once the transfer confirms", async () => {
    db.current!.tables.withdrawals.push(pendingRow(REQ_A));
    expect((await submitReq(REQ_A)).status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("owner@enki.test");
  });

  it("stays open for a banned user", async () => {
    banned = true;
    db.current!.tables.withdrawals.push(pendingRow(REQ_A));
    expect((await submitReq(REQ_A)).status).toBe(200);
  });
});
