import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { fakeDb, type FakeDb } from "./_fake-supabase";
import { resolveOrCreateSessionUserId } from "@/lib/session-user";
import { mintWalletJwt } from "@/lib/wallet-jwt";

/**
 * SOC-5: a Google or X account without an email still gets its embedded
 * wallet, and the vendor is never told an email is verified when nobody
 * verified it.
 */
const state = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => state.db.client }));
import { POST as jwtRoute } from "../../app/api/auth/wallet/jwt/route";

const UUID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const FUTURE = "2999-01-01T00:00:00.000Z";
const session = { token: "tok", wallet_address: UUID, wallet_type: "password", expires_at: FUTURE };

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.WALLET_JWT_PRIVATE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString("base64");
});
beforeEach(() => { state.db = fakeDb({ auth_sessions: [session] }); });

const call = () => jwtRoute(new NextRequest("https://enki.test/api/auth/wallet/jwt", { method: "POST", headers: { "X-Session-Token": "tok" } }));
const claims = async (res: Response) => decodeJwt((await res.json()).jwt as string);

describe("POST /api/auth/wallet/jwt", () => {
  it("mints for a social only user without any email", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [{ provider: "x", subject: "x1", user_id: UUID, email: null, email_verified: false }] });
    const res = await call();
    expect(res.status).toBe(200);
    const c = await claims(res);
    expect(c.sub).toBe(UUID);
    expect(c).not.toHaveProperty("email");
    expect(c).not.toHaveProperty("emailVerified");
  });

  it("carries an identity email but never claims it verified when the provider did not", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [{ provider: "google", subject: "g1", user_id: UUID, email: "kev@example.com", email_verified: false }] });
    expect(await claims(await call())).toMatchObject({ email: "kev@example.com", emailVerified: false });

    state.db = fakeDb({ auth_sessions: [session], auth_identities: [{ provider: "google", subject: "g1", user_id: UUID, email: "kev@example.com", email_verified: true }] });
    expect(await claims(await call())).toMatchObject({ email: "kev@example.com", emailVerified: true });
  });

  it("keeps the password account's email claim", async () => {
    state.db = fakeDb({ auth_sessions: [session], password_credentials: [{ user_id: UUID, email: "kev@example.com" }] });
    expect(await claims(await call())).toMatchObject({ sub: UUID, email: "kev@example.com", emailVerified: true });
  });

  it("still mints when the auth_identities table does not exist yet", async () => {
    state.db = fakeDb({ auth_sessions: [session] }, { auth_identities: { message: "Could not find the table", code: "PGRST205" } });
    expect((await call()).status).toBe(200);
  });
});

describe("mintWalletJwt", () => {
  it("never writes emailVerified true unless told so", async () => {
    expect(decodeJwt(await mintWalletJwt({ id: UUID, email: "a@b.c" }))).toMatchObject({ emailVerified: false });
    expect(decodeJwt(await mintWalletJwt({ id: UUID, email: "a@b.c", emailVerified: true }))).toMatchObject({ emailVerified: true });
    expect(decodeJwt(await mintWalletJwt({ id: UUID }))).not.toHaveProperty("emailVerified");
  });
});

describe("resolveOrCreateSessionUserId", () => {
  it("returns the bridge session's users.id without minting a second user", async () => {
    const db = fakeDb({ auth_sessions: [session] });
    await expect(resolveOrCreateSessionUserId(db.client, "tok")).resolves.toBe(UUID);
    expect(db.ops).not.toContain("users.insert");
  });

  it("still creates a user for an unknown wallet address", async () => {
    const db = fakeDb({ auth_sessions: [{ ...session, wallet_address: "So1anaAddr", wallet_type: "solana" }] });
    const id = await resolveOrCreateSessionUserId(db.client, "tok");
    expect(db.tables.users).toEqual([expect.objectContaining({ id })]);
    expect(db.tables.user_wallets).toEqual([expect.objectContaining({ user_id: id, address: "So1anaAddr", chain_family: "solana" })]);
  });
});
