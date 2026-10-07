import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { generateKeyPairSync } from "crypto";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Wallet unlock (Kev, 2026-10-07). CDP asks
 * /api/auth/wallet/jwt for a JWT before every wallet request, so that route
 * is where a stolen session is stopped from signing or exporting straight
 * through CDP: once the account has a second factor, the session needs a
 * wallet step-up at most 2 h old with wallet use in the last 15 min. 2FA is
 * optional: without a factor the session alone opens the wallet.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
const mails = vi.hoisted(() => [] as { to: string; subject: string }[]);
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: { to: string; subject: string }) => { mails.push(m); return { ok: true }; } }));
const sessionWallet = (token: string | null) =>
  (db.current!.tables.auth_sessions ?? []).find((s) => s.token === token)?.wallet_address as string | undefined;
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: async (_s: unknown, t: string | null) => sessionWallet(t) ?? null,
  resolveSessionUserWithBan: async (_s: unknown, t: string | null) => ({ userId: sessionWallet(t) ?? null, ban: null, wallet: sessionWallet(t) ?? null }),
}));
vi.mock("@simplewebauthn/server", async (orig) => ({
  ...(await orig<typeof import("@simplewebauthn/server")>()),
  verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 1 } }),
}));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { POST as walletJwt } from "../../app/api/auth/wallet/jwt/route";
import { POST as stepUp } from "../../app/api/auth/stepup/route";
import { POST as passkeyStepUp } from "../../app/api/auth/passkey/stepup/verify/route";
import { beginEmail, beginTotp, checkCode } from "../mfa";
import { totpCode } from "../totp";
import { setChallengeCookie } from "../webauthn";

const U = "11111111-1111-4111-8111-111111111111";
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const req = (url: string, init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://enki.test${url}`, {
    method: init.method ?? "POST",
    headers: { ...(init.token ? { "X-Session-Token": init.token } : {}), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const mint = (token = "sess") => walletJwt(req("/api/auth/wallet/jwt", { token }));
const session = (token: string) => db.current!.tables.auth_sessions.find((s) => s.token === token)!;
const unlockedAt = (iso: string) => Object.assign(session("sess"), { stepup_at: iso, stepup_seen_at: iso });

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.WALLET_JWT_PRIVATE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-07T12:00:00Z");
  db.current = fakePostgrest();
  const t = db.current.tables;
  t.users = [{ id: U, handle: "kev" }];
  // A confirmed email: until then the wallet stays closed (see "an email not yet confirmed").
  t.password_credentials = [{ user_id: U, email: "me@example.com", email_verified_at: "2026-10-01T00:00:00.000Z", must_change_password: false }];
  t.auth_sessions = [
    { token: "sess", wallet_address: U, expires_at: "2026-10-08T12:00:00.000Z" },
    { token: "other", wallet_address: U, expires_at: "2026-10-08T12:00:00.000Z" },
  ];
  t.webauthn_credentials = [];
  t.mfa_factors = [{ id: "f1", user_id: U, kind: "totp", confirmed_at: "2026-10-01T00:00:00.000Z" }];
  mails.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("the wallet JWT", () => {
  it("is minted for an account without 2FA on the session alone, and stamps nothing", async () => {
    db.current!.tables.mfa_factors = [];
    expect((await mint()).status).toBe(200);
    expect(session("sess").stepup_seen_at ?? null).toBeNull();
  });

  it("is minted for an email account whose only code factor is its email, which is none", async () => {
    db.current!.tables.mfa_factors = [];
    await beginEmail(db.current!.client, U, "me@example.com");
    const code = (mails[mails.length - 1] as unknown as { text: string }).text.match(/\b(\d{6})\b/)![1];
    expect(await checkCode(db.current!.client, U, "email", code, { confirm: true })).toBe("ok");
    expect((await mint()).status).toBe(200);
  });

  it("is refused to a session never unlocked, naming the factors that unlock it", async () => {
    const res = await mint();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ locked: true, scope: "wallet", factors: ["totp"] });
  });

  it("is minted for two hours after a step-up while the wallet is in use, never longer", async () => {
    unlockedAt("2026-10-07T12:00:00.000Z");
    for (const minute of [10, 24, 38, 52, 66, 80, 94, 108, 120]) {
      at(new Date(Date.parse("2026-10-07T12:00:00Z") + minute * 60_000).toISOString());
      expect((await mint()).status).toBe(200);
    }
    expect(session("sess").stepup_seen_at).toBe("2026-10-07T14:00:00.000Z");
    at("2026-10-07T14:00:01Z");
    expect((await mint()).status).toBe(403);
  });

  it("locks after fifteen minutes without wallet use", async () => {
    unlockedAt("2026-10-07T12:00:00.000Z");
    at("2026-10-07T12:15:00Z");
    expect((await mint()).status).toBe(200);
    at("2026-10-07T12:30:01Z");
    expect((await mint()).status).toBe(403);
  });

  it("lives two minutes", async () => {
    unlockedAt("2026-10-07T12:00:00.000Z");
    const { jwt } = await (await mint()).json();
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    expect(claims.exp - claims.iat).toBe(120);
  });

  it("is never minted when the session or the factors cannot be read", async () => {
    unlockedAt("2026-10-07T12:00:00.000Z");
    db.current!.state.failing = { table: "auth_sessions", code: "42703" };
    expect((await mint()).status).toBe(503);
    db.current!.state.failing = { table: "webauthn_credentials", code: "XX000" };
    expect((await mint()).status).toBe(503);
  });
});

describe("an email not yet confirmed", () => {
  const unconfirmed = (over: Record<string, unknown> = {}) =>
    Object.assign(db.current!.tables.password_credentials[0], { email_verified_at: null, must_change_password: false, ...over });

  it("keeps the wallet closed with the reason, before it would ask for any unlock", async () => {
    unconfirmed();
    const res = await mint();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ confirmEmail: true, error: expect.stringMatching(/Forgot password/) });
    expect(body.locked).toBeUndefined();
    expect(session("sess").stepup_seen_at ?? null).toBeNull();
  });

  it("keeps it closed while the mailed one-time password is still the password", async () => {
    unconfirmed({ email_verified_at: "2026-10-01T00:00:00.000Z", must_change_password: true });
    expect(await (await mint()).json()).toMatchObject({ confirmEmail: true });
  });

  it("sends no export alarm: there is no wallet that could be exported", async () => {
    unconfirmed();
    db.current!.tables.mfa_factors = [];
    const started = await beginTotp(db.current!.client, U, "me");
    if (typeof started === "string") throw new Error();
    expect(await checkCode(db.current!.client, U, "totp", totpCode(started.secret), { confirm: true })).toBe("ok");
    at("2026-10-07T12:00:31Z");
    const res = await stepUp(req("/api/auth/stepup", { token: "sess", body: { scope: "export", factor: "totp", code: totpCode(started.secret) } }));
    expect(res.status).toBe(200);
    expect(mails).toEqual([]);
  });
});

describe("a step-up", () => {
  async function totpFactor(): Promise<string> {
    db.current!.tables.mfa_factors = [];
    const started = await beginTotp(db.current!.client, U, "me");
    if (typeof started === "string") throw new Error();
    expect(await checkCode(db.current!.client, U, "totp", totpCode(started.secret), { confirm: true })).toBe("ok");
    at("2026-10-07T12:00:31Z");
    return started.secret;
  }
  const codeStepUp = (secret: string, scope: string) =>
    stepUp(req("/api/auth/stepup", { token: "sess", body: { scope, factor: "totp", code: totpCode(secret) } }));

  it("for the wallet unlocks the session it came from, and no other", async () => {
    const secret = await totpFactor();
    expect((await codeStepUp(secret, "wallet")).status).toBe(200);
    expect(session("sess").stepup_at).toBe("2026-10-07T12:00:31.000Z");
    expect((await mint("sess")).status).toBe(200);
    expect((await mint("other")).status).toBe(403);
  });

  it("that cannot stamp the session says the code is spent, and mints nothing", async () => {
    const secret = await totpFactor();
    db.current!.state.failing = { table: "auth_sessions", code: "XX000" };
    const res = await codeStepUp(secret, "wallet");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/new code/);
  });

  it("for an export unlocks too and tells the owner by mail; anything else does neither", async () => {
    const secret = await totpFactor();
    expect((await codeStepUp(secret, "add-factor")).status).toBe(200);
    at("2026-10-07T12:01:01Z");
    expect((await codeStepUp(secret, "wallet")).status).toBe(200);
    expect(mails).toEqual([]);
    session("sess").stepup_at = null;
    at("2026-10-07T12:01:31Z");
    expect((await codeStepUp(secret, "export")).status).toBe(200);
    expect(session("sess").stepup_at).toBe("2026-10-07T12:01:31.000Z");
    expect(mails.map((m) => [m.to, m.subject])).toEqual([["me@example.com", "Your Enki wallet key is being exported"]]);
  });

  it("for anything but the wallet or an export unlocks nothing", async () => {
    const secret = await totpFactor();
    expect((await codeStepUp(secret, "add-factor")).status).toBe(200);
    expect(session("sess").stepup_at ?? null).toBeNull();
  });

  it("with a passkey unlocks the wallet the same way", async () => {
    db.current!.tables.webauthn_credentials = [{ id: "pk1", user_id: U, credential_id: "cred1", public_key: "AAAA", counter: 0, transports: null }];
    const issued = NextResponse.json({});
    setChallengeCookie(issued, "pk_auth_challenge", "challenge", U);
    const res = await passkeyStepUp(req("/api/auth/passkey/stepup/verify", {
      token: "sess",
      headers: { cookie: `pk_auth_challenge=${issued.cookies.get("pk_auth_challenge")!.value}` },
      body: { response: { id: "cred1" }, scope: "wallet" },
    }));
    expect(res.status).toBe(200);
    expect(session("sess").stepup_at).toBe("2026-10-07T12:00:00.000Z");
  });
  // Last in its block: the rate limiter lives in the process, and this fills U's bucket.
  it("mails the export notice to the login email, three an hour at most", async () => {
    const secret = await totpFactor();
    at("2026-10-07T20:00:00Z");
    for (let i = 1; i <= 4; i++) {
      at(new Date(Date.parse("2026-10-07T20:00:00Z") + i * 31_000).toISOString());
      expect((await codeStepUp(secret, "export")).status).toBe(200);
    }
    expect(mails.map((m) => m.to)).toEqual(["me@example.com", "me@example.com", "me@example.com"]);
  });
});
