import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { generateKeyPairSync } from "crypto";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Signup is email + password, straight in (Kev, 2026-10-07): no code, no
 * factor; 2FA stays optional and a red bar asks for it. During the private
 * beta it is wired but closed, on the server too (SIGNUP_OPEN). The wallet JWT says
 * nothing about the email being verified: nobody verified it, and CDP reads
 * only iss, sub, exp and iat.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
const mails: unknown[] = [];
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: unknown) => { mails.push(m); return { ok: true }; } }));
vi.mock("@/lib/ip-hash", () => ({ getClientIp: () => "203.0.113.9", hashIp: () => "iphash", isIpBanned: async () => false }));
// Before the imports below: the password hash reads the pepper; the field key
// is set so that a code factor, were one ever started at signup, would show.
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { POST as register } from "../../app/api/auth/password/register/route";
import { POST as walletJwt } from "../../app/api/auth/wallet/jwt/route";

const EMAIL = "new@example.com";
const U = "11111111-1111-4111-8111-111111111111";
const post = (url: string, body: unknown, token?: string) =>
  new NextRequest(`http://enki.test${url}`, {
    method: "POST",
    headers: token ? { "X-Session-Token": token } : {},
    body: JSON.stringify(body),
  });

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.WALLET_JWT_PRIVATE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  db.current = fakePostgrest();
  db.current.tables.users = [];
  db.current.tables.password_credentials = [];
  db.current.tables.auth_sessions = [];
  db.current.tables.mfa_factors = [];
  mails.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("signing up", () => {
  it.each([undefined, "0"])("is closed during the private beta (SIGNUP_OPEN=%s), whatever the form shows: nothing is created", async (open) => {
    vi.stubEnv("SIGNUP_OPEN", open);
    const res = await register(post("/api/auth/password/register", { email: EMAIL, password: "a long password" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ closed: true });
    expect(db.current!.tables.users).toEqual([]);
    expect(db.current!.tables.password_credentials).toEqual([]);
    expect(db.current!.tables.auth_sessions).toEqual([]);
  });

  it("once open, lets the account straight in: a session, no mail, no factor", async () => {
    vi.stubEnv("SIGNUP_OPEN", "1");
    const res = await register(post("/api/auth/password/register", { email: EMAIL, password: "a long password" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe(EMAIL);
    expect(typeof body.token).toBe("string");
    expect(Object.keys(body).sort()).toEqual(["email", "expiresAt", "token"]);
    expect(mails).toEqual([]);
    expect(db.current!.tables.mfa_factors).toEqual([]);
  });
});

describe("the wallet JWT", () => {
  beforeEach(() => {
    db.current!.tables.users = [{ id: U, handle: "kev" }];
    db.current!.tables.auth_sessions = [{ token: "sess", wallet_address: U, expires_at: "2026-10-08T12:00:00.000Z" }];
    db.current!.tables.password_credentials = [{ user_id: U, email: EMAIL }];
  });

  it("names the user and the email, and claims nothing about the email being verified", async () => {
    const { jwt } = await (await walletJwt(post("/api/auth/wallet/jwt", {}, "sess"))).json();
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ sub: U, email: EMAIL, username: "kev" });
    expect(claims).not.toHaveProperty("emailVerified");
  });

  it("answers 503 when the account cannot be read, never a JWT", async () => {
    db.current!.state.failing = { table: "password_credentials", code: "42703" };
    expect((await walletJwt(post("/api/auth/wallet/jwt", {}, "sess"))).status).toBe(503);
  });
});
