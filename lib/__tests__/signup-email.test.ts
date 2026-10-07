import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { generateKeyPairSync } from "crypto";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Signup confirms the login email with a code, and that address is the
 * account's first step-up factor (Kev, 2026-10-07). The wallet JWT says
 * emailVerified only once that happened; before, it said so for everyone.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
const mails: { to: string; text: string }[] = [];
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: { to: string; text: string }) => { mails.push(m); return { ok: true }; } }));
vi.mock("@/lib/ip-hash", () => ({ getClientIp: () => "203.0.113.9", hashIp: () => "iphash", isIpBanned: async () => false }));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: async (_s: unknown, token: string | null) =>
    (db.current!.tables.auth_sessions ?? []).find((s) => s.token === token)?.wallet_address ?? null,
}));
// Before the imports below: the password hash, the sealed address and the code HMAC read these.
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { POST as register } from "../../app/api/auth/password/register/route";
import { POST as verifyEmail } from "../../app/api/auth/password/verify-email/route";
import { POST as walletJwt } from "../../app/api/auth/wallet/jwt/route";
import { beginEmail } from "../mfa";

const EMAIL = "new@example.com";
const post = (url: string, body: unknown, token?: string) =>
  new NextRequest(`http://enki.test${url}`, {
    method: "POST",
    headers: token ? { "X-Session-Token": token } : {},
    body: JSON.stringify(body),
  });
const lastCode = () => mails[mails.length - 1].text.match(/\b(\d{6})\b/)![1];
const at = (iso: string) => vi.setSystemTime(new Date(iso));

async function signUp(): Promise<{ token: string; userId: string }> {
  const res = await register(post("/api/auth/password/register", { email: EMAIL, password: "a long password" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.codeSent).toBe(true);
  return { token: body.token, userId: db.current!.tables.users[0].id as string };
}

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.WALLET_JWT_PRIVATE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-07T12:00:00Z");
  db.current = fakePostgrest();
  db.current.tables.users = [];
  db.current.tables.password_credentials = [];
  db.current.tables.auth_sessions = [];
  db.current.tables.mfa_factors = [];
  mails.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("signing up", () => {
  it("mails a code to the login email, and the right code makes it the first factor", async () => {
    const { token } = await signUp();
    expect(mails.map((m) => m.to)).toEqual([EMAIL]);
    expect((await verifyEmail(post("/x", { code: "000000" }, token))).status).toBe(400);
    expect(db.current!.tables.password_credentials[0].email_verified_at ?? null).toBeNull();

    const res = await verifyEmail(post("/x", { code: lastCode() }, token));
    expect(await res.json()).toEqual({ verified: true });
    expect(db.current!.tables.password_credentials[0].email_verified_at).toBe("2026-10-07T12:00:00.000Z");
    expect(db.current!.tables.mfa_factors[0]).toMatchObject({ kind: "email", confirmed_at: "2026-10-07T12:00:00.000Z" });
  });

  it("sends a new code on request, once a minute", async () => {
    const { token } = await signUp();
    expect((await verifyEmail(post("/x", {}, token))).status).toBe(429);
    at("2026-10-07T12:01:01Z");
    expect(await (await verifyEmail(post("/x", {}, token))).json()).toEqual({ sent: true });
    expect(mails).toHaveLength(2);
    expect((await verifyEmail(post("/x", { code: lastCode() }, token))).status).toBe(200);
  });

  it("never verifies the login email with a code sent to another address", async () => {
    const { token, userId } = await signUp();
    at("2026-10-07T12:01:01Z");
    await beginEmail(db.current!.client, userId, "other@example.com");
    expect(mails[mails.length - 1].to).toBe("other@example.com");
    expect((await verifyEmail(post("/x", { code: lastCode() }, token))).status).toBe(409);
    expect(db.current!.tables.password_credentials[0].email_verified_at ?? null).toBeNull();
    expect(db.current!.tables.mfa_factors[0].confirmed_at ?? null).toBeNull();
  });
});

describe("the wallet JWT", () => {
  const U = "11111111-1111-4111-8111-111111111111";
  const claims = async () => {
    const { jwt } = await (await walletJwt(post("/api/auth/wallet/jwt", {}, "sess"))).json();
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  };
  beforeEach(() => {
    db.current!.tables.users = [{ id: U, handle: "kev" }];
    db.current!.tables.auth_sessions = [{
      token: "sess", wallet_address: U, expires_at: "2026-10-08T12:00:00.000Z",
      stepup_at: "2026-10-07T11:59:00.000Z", stepup_seen_at: "2026-10-07T11:59:00.000Z",
    }];
    db.current!.tables.password_credentials = [{ user_id: U, email: EMAIL, email_verified_at: null }];
    db.current!.tables.webauthn_credentials = [];
    db.current!.tables.mfa_factors = [{ id: "f1", user_id: U, kind: "totp", confirmed_at: "2026-10-01T00:00:00.000Z" }];
  });

  it("calls the email verified only once the signup code was confirmed", async () => {
    expect((await claims()).emailVerified).toBe(false);
    db.current!.tables.password_credentials[0].email_verified_at = "2026-10-07T12:00:00.000Z";
    expect(await claims()).toMatchObject({ sub: U, email: EMAIL, emailVerified: true });
  });

  it("answers 503 when the account cannot be read, never a JWT", async () => {
    db.current!.state.failing = { table: "password_credentials", code: "42703" };
    expect((await walletJwt(post("/api/auth/wallet/jwt", {}, "sess"))).status).toBe(503);
  });
});
