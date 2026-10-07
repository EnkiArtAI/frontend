import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Invited accounts (Kev, 2026-10-07): the admin's approval mails a one-time
 * password. It opens no session, only the step that replaces it with the
 * user's own; that step confirms the email (the password came through the
 * inbox), and from then on only the new password logs in. A reset through
 * the inbox confirms the email too; a guardian recovery proves no inbox.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
const net = vi.hoisted(() => ({ ipBanned: false, banned: false, banDown: false }));
vi.mock("@/lib/ip-hash", () => ({ getClientIp: () => "203.0.113.9", hashIp: () => "iphash", isIpBanned: async () => net.ipBanned }));
vi.mock("@/lib/session-user", () => ({
  activeBanFor: async () => {
    if (net.banDown) throw new Error("bans unreadable");
    return net.banned ? { id: "b1", reason: null, expiresAt: null } : null;
  },
}));
const mails: { to: string; subject: string; text: string }[] = [];
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: { to: string; subject: string; text: string }) => { mails.push(m); return { ok: true }; } }));
// Before the imports below: the password hash reads the pepper at load.
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64"); });

import { POST as login } from "../../app/api/auth/password/login/route";
import { POST as firstLogin } from "../../app/api/auth/password/first-login/route";
import { POST as forgot } from "../../app/api/auth/password/forgot/route";
import { POST as resetCode } from "../../app/api/auth/password/reset-code/route";
import { hashPassword } from "../password-auth";
import { completePasswordReset } from "../password-reset";

// Every login runs Argon2id (64 MiB, 3 passes): a test with several takes seconds.
vi.setConfig({ testTimeout: 60_000 });

const U = "11111111-1111-4111-8111-111111111111";
const EMAIL = "invited@example.com";
const ONE_TIME = "K7QM2XWB9RTPHDZA4NVC";

const post = (url: string, body: unknown) =>
  new NextRequest(`http://enki.test${url}`, { method: "POST", body: JSON.stringify(body) });
const cred = () => db.current!.tables.password_credentials[0];
const seed = (password: string, mustChange: boolean) => {
  const { hash, salt } = hashPassword(password);
  db.current!.tables.password_credentials = [{
    user_id: U, email: EMAIL, pw_hash: hash, pw_salt: salt, must_change_password: mustChange, email_verified_at: null,
  }];
};

beforeEach(() => {
  db.current = fakePostgrest();
  const t = db.current.tables;
  t.users = [{ id: U, handle: null }];
  t.auth_sessions = [];
  t.user_wallets = [];
  t.password_reset_tokens = [];
  t.access_allowlist = [{ kind: "email", value: EMAIL }];
  Object.assign(net, { ipBanned: false, banned: false, banDown: false });
  mails.length = 0;
  vi.stubEnv("TEAM_ACCESS_CODE", "beta-code"); // the whitelist stage
  seed(ONE_TIME, true);
});
afterEach(() => vi.unstubAllEnvs());

describe("the mailed one-time password", () => {
  it("opens no session at login, only the step that replaces it", async () => {
    const res = await login(post("/api/auth/password/login", { identifier: EMAIL, password: ONE_TIME }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ setPassword: true });
    expect(db.current!.tables.auth_sessions).toEqual([]);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("is replaced by the user's own at the first login, which confirms the email and logs in", async () => {
    const res = await firstLogin(post("/api/auth/password/first-login", { email: EMAIL, password: ONE_TIME, newPassword: "my own password" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ email: EMAIL });
    expect(db.current!.tables.auth_sessions.map((s) => s.token)).toEqual([body.token]);
    expect(res.headers.get("set-cookie")).toMatch(/enki_team=/);
    expect(cred().must_change_password).toBe(false);
    expect(cred().email_verified_at).toEqual(expect.any(String));

    expect((await login(post("/api/auth/password/login", { identifier: EMAIL, password: ONE_TIME }))).status).toBe(401);
    const again = await login(post("/api/auth/password/login", { identifier: EMAIL, password: "my own password" }));
    expect(await again.json()).toMatchObject({ email: EMAIL, token: expect.any(String) });
  });

  it("changes nothing for a wrong one, nor for a new password that is too short or the same", async () => {
    const before = { ...cred() };
    expect((await firstLogin(post("/api/auth/password/first-login", { email: EMAIL, password: "guess", newPassword: "my own password" }))).status).toBe(401);
    expect((await firstLogin(post("/api/auth/password/first-login", { email: EMAIL, password: ONE_TIME, newPassword: ONE_TIME }))).status).toBe(400);
    expect((await firstLogin(post("/api/auth/password/first-login", { email: EMAIL, password: ONE_TIME, newPassword: "short" }))).status).toBe(400);
    expect(cred()).toEqual(before);
    expect(db.current!.tables.auth_sessions).toEqual([]);
  });

  it("checks no password the user chose: such an account gets the wrong-password answer, unchanged", async () => {
    seed("their own password", false);
    const res = await firstLogin(post("/api/auth/password/first-login", { email: EMAIL, password: "their own password", newPassword: "taken over" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Wrong login or password");
    const ok = await login(post("/api/auth/password/login", { identifier: EMAIL, password: "their own password" }));
    expect(await ok.json()).toMatchObject({ token: expect.any(String) });
  });

  it("lets one of two first logins at once win; the other changes nothing", async () => {
    const [a, b] = await Promise.all([
      firstLogin(post("/api/auth/password/first-login", { email: EMAIL, password: ONE_TIME, newPassword: "first choice" })),
      firstLogin(post("/api/auth/password/first-login", { email: EMAIL, password: ONE_TIME, newPassword: "second choice" })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(db.current!.tables.auth_sessions).toHaveLength(1);
    const winner = a.status === 200 ? "first choice" : "second choice";
    expect((await login(post("/api/auth/password/login", { identifier: EMAIL, password: winner }))).status).toBe(200);
  });

  it("says the password is set when the session cannot open after it", async () => {
    db.current!.state.failNext = { table: "auth_sessions", op: "insert", code: "XX000" };
    const res = await firstLogin(post("/api/auth/password/first-login", { email: EMAIL, password: ONE_TIME, newPassword: "my own password" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ passwordSet: true });
    expect(cred().must_change_password).toBe(false);
  });

  it("still needs the access list during the beta", async () => {
    db.current!.tables.access_allowlist = [];
    const before = { ...cred() };
    expect((await login(post("/api/auth/password/login", { identifier: EMAIL, password: ONE_TIME }))).status).toBe(401);
    expect((await firstLogin(post("/api/auth/password/first-login", { email: EMAIL, password: ONE_TIME, newPassword: "my own password" }))).status).toBe(401);
    expect(cred()).toEqual(before);
  });

  it("is refused on a blocked network before anything changes", async () => {
    net.ipBanned = true;
    const before = { ...cred() };
    expect((await firstLogin(post("/api/auth/password/first-login", { email: EMAIL, password: ONE_TIME, newPassword: "my own password" }))).status).toBe(403);
    expect(cred()).toEqual(before);
  });

  it("reads as an outage, never as a wrong password, when the credential cannot be read", async () => {
    db.current!.state.failing = { table: "password_credentials", code: "42703" };
    expect((await login(post("/api/auth/password/login", { identifier: EMAIL, password: ONE_TIME }))).status).toBe(503);
    expect((await firstLogin(post("/api/auth/password/first-login", { email: EMAIL, password: ONE_TIME, newPassword: "my own password" }))).status).toBe(503);
  });
});

describe("a password reset", () => {
  it("through the inbox confirms the email, retires a one-time password and enters like a login", async () => {
    await forgot(post("/api/auth/password/forgot", { email: EMAIL }));
    const code = /\b(\d{7})\b/.exec(mails[0].text)![1];
    const res = await resetCode(post("/api/auth/password/reset-code", { email: EMAIL, code, password: "my own password" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/enki_team=/);
    expect(cred().must_change_password).toBe(false);
    expect(cred().email_verified_at).toEqual(expect.any(String));
  });

  it("through the inbox is refused off the access list, and the code stays usable", async () => {
    await forgot(post("/api/auth/password/forgot", { email: EMAIL }));
    const code = /\b(\d{7})\b/.exec(mails[0].text)![1];
    db.current!.tables.access_allowlist = [];
    const before = { ...cred() };
    expect((await resetCode(post("/api/auth/password/reset-code", { email: EMAIL, code, password: "my own password" }))).status).toBe(401);
    expect(cred()).toEqual(before);
    expect(db.current!.tables.password_reset_tokens).toHaveLength(1);
  });

  it("through the inbox records the network of the login it ends in", async () => {
    await forgot(post("/api/auth/password/forgot", { email: EMAIL }));
    const code = /\b(\d{7})\b/.exec(mails[0].text)![1];
    const res = await resetCode(post("/api/auth/password/reset-code", { email: EMAIL, code, password: "my own password" }));
    expect(res.status).toBe(200);
    expect(db.current!.tables.auth_sessions.map((s) => s.ip_hash)).toEqual(["iphash"]);
  });

  it("through the inbox, when the ban cannot be read, leaves the password and the code as they were", async () => {
    await forgot(post("/api/auth/password/forgot", { email: EMAIL }));
    const code = /\b(\d{7})\b/.exec(mails[0].text)![1];
    net.banDown = true;
    const before = { ...cred() };
    await expect(resetCode(post("/api/auth/password/reset-code", { email: EMAIL, code, password: "my own password" }))).rejects.toThrow();
    expect(cred()).toEqual(before);
    expect(db.current!.tables.password_reset_tokens).toHaveLength(1);
  });

  it("through the inbox sends a banned account to /banned, like a login", async () => {
    net.banned = true;
    await forgot(post("/api/auth/password/forgot", { email: EMAIL }));
    const code = /\b(\d{7})\b/.exec(mails[0].text)![1];
    const res = await resetCode(post("/api/auth/password/reset-code", { email: EMAIL, code, password: "my own password" }));
    expect(await res.json()).toMatchObject({ banned: true });
    // The team cookie opens every page: a banned account loses it (BAN-1).
    expect(res.headers.get("set-cookie")).toMatch(/enki_team=;.*Max-Age=0/i);
  });

  it("a banned invitee's first login is routed to /banned and loses the team cookie", async () => {
    net.banned = true;
    // Past the per-email window of the first logins above.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    const res = await firstLogin(post("/api/auth/password/first-login", { email: EMAIL, password: ONE_TIME, newPassword: "my own password" }))
      .finally(() => clock.mockRestore());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ banned: true });
    expect(res.headers.get("set-cookie")).toMatch(/enki_team=;.*Max-Age=0/i);
  });

  it("by guardians confirms nothing: they prove no inbox", async () => {
    await completePasswordReset(db.current!.client, U, "set by guardians");
    expect(cred().must_change_password).toBe(true);
    expect(cred().email_verified_at).toBeNull();
  });
});
