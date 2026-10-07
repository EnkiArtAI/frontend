import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * BAN-8. Once a user has a second factor, building a withdrawal asks for it,
 * for that destination. The gate sits at /build because the transaction
 * leaves it signed by our fee payer: after the wallet signs, anyone can
 * broadcast it without /submit.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64"); });

const U = "11111111-1111-4111-8111-111111111111";
const FROM = Keypair.generate().publicKey.toBase58();
const TO = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const built = vi.fn(async () => ({ transaction: "dHg=", messageHash: "h" }));

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
vi.mock("@/lib/payments/withdraw", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/withdraw")>()),
  resolveWithdrawer: async () => ({ userId: U, from: FROM }),
  checkWithdrawRequest: () => null,
  recentWithdrawalCount: async () => 0,
  withdrawLimited: () => null,
  buildWithdrawTx: () => built(),
  insertWithdrawal: async () => ({ id: "w1" }),
}));

import { POST } from "../../app/api/wallet/withdraw/build/route";
import { mintStepUpToken } from "../webauthn";

const build = (to: string, token?: string) =>
  POST(new NextRequest("http://enki.test/api/wallet/withdraw/build", {
    method: "POST",
    headers: { "X-Session-Token": "s", ...(token ? { "X-StepUp-Token": token } : {}) },
    body: JSON.stringify({ from: FROM, to, amountMicro: 1_000_000 }),
  }));

beforeEach(() => {
  db.current = fakePostgrest();
  db.current.tables.webauthn_credentials = [];
  db.current.tables.mfa_factors = [];
  built.mockClear();
});

describe("building a withdrawal", () => {
  it("needs nothing extra without a second factor", async () => {
    expect((await build(TO)).status).toBe(200);
  });

  it("asks for the factor, for this destination, once one is set up", async () => {
    db.current!.tables.mfa_factors.push({ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" });
    const bare = await build(TO);
    expect(bare.status).toBe(401);
    expect((await bare.json()).stepUp).toBe(true);
    expect((await build(TO, await mintStepUpToken(U, `withdraw:${OTHER}`))).status).toBe(401);
    expect(built).not.toHaveBeenCalled();
    expect((await build(TO, await mintStepUpToken(U, `withdraw:${TO}`))).status).toBe(200);
    expect(built).toHaveBeenCalledOnce();
  });
});
