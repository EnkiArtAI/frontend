import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Adding and removing factors (MFA-3 basis). Today a stolen session could
 * register its own passkey, delete the owner's and add guardians, and then
 * own every step-up. Now the first factor takes a fresh login, every further
 * one a step-up, and a factor or a guardian changes only with a factor.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
const mails: { text: string }[] = [];
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: { text: string }) => { mails.push(m); return { ok: true }; } }));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: async () => U,
  resolveSessionUserWithBan: async () => ({ userId: U, ban: null, wallet: U }),
}));
vi.mock("@/lib/auth", () => ({ requireAuth: async () => ({ walletAddress: U }) }));

// Before the imports below: a route module reads the pepper when it loads.
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

const U = "11111111-1111-4111-8111-111111111111";
const PASSKEY = "22222222-2222-4222-8222-222222222222";

import { POST as setup, DELETE as remove } from "../../app/api/auth/mfa/[kind]/route";
import { POST as confirm } from "../../app/api/auth/mfa/[kind]/confirm/route";
import { POST as passkeyOptions } from "../../app/api/auth/passkey/register/options/route";
import { DELETE as removePasskey } from "../../app/api/auth/passkey/credentials/route";
import { POST as addGuardian, PATCH as guardianThreshold, DELETE as removeGuardian } from "../../app/api/recovery/guardians/route";
import { mintStepUpToken } from "../webauthn";
import { totpCode } from "../totp";

const req = (url: string, method: string, body?: unknown, token?: string) =>
  new NextRequest(`http://enki.test${url}`, {
    method,
    headers: { "X-Session-Token": "sess", ...(token ? { "X-StepUp-Token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const kind = (k: string) => ({ params: Promise.resolve({ kind: k }) });
const sessionAge = (minutes: number) => {
  db.current!.tables.auth_sessions = [{ token: "sess", created_at: new Date(Date.now() - minutes * 60_000).toISOString() }];
};

async function withTotp(): Promise<string> {
  sessionAge(1);
  const { secret } = await (await setup(req("/api/auth/mfa/totp", "POST", {}), kind("totp"))).json();
  expect((await confirm(req("/api/auth/mfa/totp/confirm", "POST", { code: totpCode(secret) }), kind("totp"))).status).toBe(200);
  return secret;
}

beforeEach(() => {
  db.current = fakePostgrest();
  db.current.tables.users = [{ id: U, handle: "kev" }];
  db.current.tables.webauthn_credentials = [];
  db.current.tables.mfa_factors = [];
  db.current.tables.recovery_guardians = [];
  mails.length = 0;
});

describe("the first factor", () => {
  it("takes a login younger than ten minutes", async () => {
    sessionAge(11);
    const stale = await setup(req("/api/auth/mfa/totp", "POST", {}), kind("totp"));
    expect(stale.status).toBe(403);
    expect((await stale.json()).reauth).toBe(true);
    expect((await passkeyOptions(req("/api/auth/passkey/register/options", "POST"))).status).toBe(403);

    sessionAge(9);
    const fresh = await setup(req("/api/auth/mfa/totp", "POST", {}), kind("totp"));
    expect(fresh.status).toBe(200);
    expect((await fresh.json()).uri).toMatch(/^otpauth:\/\/totp\//);
  });

  it("takes no email address longer than one can be", async () => {
    sessionAge(1);
    const at = (domain: number) => `${"a".repeat(64)}@${"b".repeat(domain)}.com`;
    expect((await setup(req("/api/auth/mfa/email", "POST", { email: at(186) }), kind("email"))).status).toBe(400);
    expect((await setup(req("/api/auth/mfa/email", "POST", { email: at(185) }), kind("email"))).status).toBe(200);
  });

  it("counts only once confirmed with a right code", async () => {
    sessionAge(1);
    const { secret } = await (await setup(req("/api/auth/mfa/totp", "POST", {}), kind("totp"))).json();
    expect((await confirm(req("/x", "POST", { code: "000000" }), kind("totp"))).status).toBe(400);
    expect((await confirm(req("/x", "POST", { code: totpCode(secret) }), kind("totp"))).status).toBe(200);
  });
});

describe("a further factor", () => {
  it("needs a step-up for add-factor, even from a fresh login", async () => {
    await withTotp();
    expect((await setup(req("/api/auth/mfa/email", "POST", { email: "me@example.com" }), kind("email"))).status).toBe(401);
    expect((await passkeyOptions(req("/api/auth/passkey/register/options", "POST"))).status).toBe(401);
    const token = await mintStepUpToken(U, "add-factor");
    expect((await setup(req("/api/auth/mfa/email", "POST", { email: "me@example.com" }, token), kind("email"))).status).toBe(200);
    expect(mails).toHaveLength(1);
    expect((await passkeyOptions(req("/api/auth/passkey/register/options", "POST", undefined, token))).status).toBe(200);
  });
});

describe("removing a factor", () => {
  it("takes a step-up naming that factor", async () => {
    await withTotp();
    expect((await remove(req("/api/auth/mfa/totp", "DELETE"), kind("totp"))).status).toBe(401);
    const wrong = await mintStepUpToken(U, "remove-factor:email");
    expect((await remove(req("/api/auth/mfa/totp", "DELETE", undefined, wrong), kind("totp"))).status).toBe(401);
    expect(db.current!.tables.mfa_factors).toHaveLength(1);
    const right = await mintStepUpToken(U, "remove-factor:totp");
    expect((await remove(req("/api/auth/mfa/totp", "DELETE", undefined, right), kind("totp"))).status).toBe(200);
    expect(db.current!.tables.mfa_factors).toHaveLength(0);
  });

  it("covers a passkey too", async () => {
    db.current!.tables.webauthn_credentials.push({ id: PASSKEY, user_id: U });
    expect((await removePasskey(req("/api/auth/passkey/credentials", "DELETE", { id: PASSKEY }))).status).toBe(401);
    expect(db.current!.tables.webauthn_credentials).toHaveLength(1);
    const token = await mintStepUpToken(U, `remove-factor:${PASSKEY}`);
    expect((await removePasskey(req("/api/auth/passkey/credentials", "DELETE", { id: PASSKEY }, token))).status).toBe(200);
    expect(db.current!.tables.webauthn_credentials).toHaveLength(0);
  });
});

describe("guardians", () => {
  it("are added, re-thresholded and removed only with a step-up once a factor exists", async () => {
    await withTotp();
    expect((await addGuardian(req("/api/recovery/guardians", "POST", { guardianType: "email", value: "g@example.com" }))).status).toBe(401);
    expect((await guardianThreshold(req("/api/recovery/guardians", "PATCH", { threshold: 2 }))).status).toBe(401);
    expect((await removeGuardian(req("/api/recovery/guardians?id=g1", "DELETE"))).status).toBe(401);
  });

  it("are added only through the gate, whatever ids the body carries", async () => {
    await withTotp();
    const add = { guardianType: "email", value: "g@example.com" };
    expect((await addGuardian(req("/api/recovery/guardians", "POST", { ...add, verifyId: "x" }))).status).toBe(401);
    expect((await addGuardian(req("/api/recovery/guardians", "POST", { ...add, phoneVerifyId: "x" }))).status).toBe(401);
    expect(db.current!.tables.recovery_guardians).toHaveLength(0);
    const token = await mintStepUpToken(U, "guardians");
    expect((await addGuardian(req("/api/recovery/guardians", "POST", add, token))).status).toBe(201);
    expect(db.current!.tables.recovery_guardians).toHaveLength(1);
  });

  it("without a factor take a fresh login, like a first factor", async () => {
    const add = { guardianType: "email", value: "g@example.com" };
    sessionAge(11);
    const stale = await addGuardian(req("/api/recovery/guardians", "POST", add));
    expect(stale.status).toBe(403);
    expect((await stale.json()).reauth).toBe(true);
    expect((await guardianThreshold(req("/api/recovery/guardians", "PATCH", { threshold: 1 }))).status).toBe(403);
    expect(db.current!.tables.recovery_guardians).toHaveLength(0);
    sessionAge(9);
    expect((await addGuardian(req("/api/recovery/guardians", "POST", add))).status).toBe(201);
  });

  it("still let an added authenticator guardian be confirmed without one", async () => {
    await withTotp();
    const res = await addGuardian(req("/api/recovery/guardians", "POST", { verifyId: "g1", code: "123456" }));
    expect(res.status).toBe(404); // reached the confirm path: no such guardian here
  });
});
