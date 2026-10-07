import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { generateKeyPairSync } from "crypto";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Private-beta access (Kev, 2026-10-07): an admin approves a request or
 * invites an email or a wallet. An invited email gets an account and a mailed
 * one-time password that opens only the first-login step; the wallet opens
 * after it. A wallet only goes on the access list. Mods grant nothing.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
const mailer = vi.hoisted(() => ({ ok: true, sent: [] as { to: string; subject: string; text: string }[] }));
vi.mock("@/lib/mailer", () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => { mailer.sent.push(m); return { ok: mailer.ok }; },
}));
vi.mock("@/lib/ip-hash", () => ({ getClientIp: () => "203.0.113.9", hashIp: () => "iphash", isIpBanned: async () => false }));
const caller = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/session-user", () => ({
  activeBanFor: async () => null,
  resolveSessionUserId: async () => caller.userId,
}));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { AccessError, accessFor, approveRequest, inviteEmail, inviteWallet, loadAccess, oneTimePassword, rejectRequest } from "../access-invite";
import { POST as login } from "../../app/api/auth/password/login/route";
import { POST as firstLogin } from "../../app/api/auth/password/first-login/route";
import { POST as walletJwt } from "../../app/api/auth/wallet/jwt/route";
import { POST as admin } from "../../app/api/admin/route";

// Argon2id on every invite and login: tests here take seconds.
vi.setConfig({ testTimeout: 60_000 });

const UID = "22222222-2222-4222-8222-222222222222";
const SOL = "So11111111111111111111111111111111111111112";
const post = (url: string, body: unknown, token?: string) =>
  new NextRequest(`http://enki.test${url}`, { method: "POST", headers: token ? { "X-Session-Token": token } : {}, body: JSON.stringify(body) });
const lastPassword = () => /one-time password: ([A-Z2-9]{20})/.exec(mailer.sent[mailer.sent.length - 1].text)![1];

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.WALLET_JWT_PRIVATE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
});
beforeEach(() => {
  db.current = fakePostgrest();
  const t = db.current.tables;
  t.users = [];
  t.password_credentials = [];
  t.access_allowlist = [];
  t.access_requests = [];
  t.auth_sessions = [];
  t.user_wallets = [];
  t.webauthn_credentials = [];
  t.mfa_factors = [];
  mailer.ok = true;
  mailer.sent.length = 0;
  caller.userId = null;
  vi.stubEnv("TEAM_ACCESS_CODE", "beta-code");
});
afterEach(() => vi.unstubAllEnvs());

describe("an invited email", () => {
  it("gets an account on the access list and a mailed one-time password that opens only the first login; the wallet opens after it", async () => {
    expect(await inviteEmail(db.current!.client, "  New@Example.com ")).toEqual({ outcome: "invited", mailed: true });
    const t = db.current!.tables;
    expect(t.access_allowlist).toEqual([expect.objectContaining({ kind: "email", value: "new@example.com" })]);
    expect(t.users).toEqual([expect.objectContaining({ role: "beta", account_status: "active" })]);
    expect(t.password_credentials[0]).toMatchObject({ email: "new@example.com", must_change_password: true });
    const mail = mailer.sent[0];
    const password = lastPassword();
    expect(mail.to).toBe("new@example.com");
    expect(mail.subject).not.toContain(password);
    expect(t.password_credentials[0].pw_hash).not.toContain(password);

    // The test fake names rows users-1; the wallet JWT wants a uuid.
    t.users[0].id = UID;
    t.password_credentials[0].user_id = UID;
    expect(await (await login(post("/api/auth/password/login", { identifier: "new@example.com", password }))).json()).toEqual({ setPassword: true });
    const first = await firstLogin(post("/api/auth/password/first-login", { email: "new@example.com", password, newPassword: "my own password" }));
    const { token } = await first.json();
    expect((await walletJwt(post("/api/auth/wallet/jwt", {}, token))).status).toBe(200);
  });

  it("invited again before its first login gets a fresh one-time password, and the old one stops working", async () => {
    await inviteEmail(db.current!.client, "new@example.com");
    const old = lastPassword();
    expect(await inviteEmail(db.current!.client, "new@example.com")).toEqual({ outcome: "reinvited", mailed: true });
    const fresh = lastPassword();
    expect(fresh).not.toBe(old);
    expect(db.current!.tables.users).toHaveLength(1);
    expect(db.current!.tables.access_allowlist).toHaveLength(1);
    expect((await login(post("/api/auth/password/login", { identifier: "new@example.com", password: old }))).status).toBe(401);
    expect(await (await login(post("/api/auth/password/login", { identifier: "new@example.com", password: fresh }))).json()).toEqual({ setPassword: true });
  });

  it("with its own password already is left alone: nothing mailed, nothing changed", async () => {
    await inviteEmail(db.current!.client, "new@example.com");
    const password = lastPassword();
    await firstLogin(post("/api/auth/password/first-login", { email: "new@example.com", password, newPassword: "my own password" }));
    const before = { ...db.current!.tables.password_credentials[0] };
    expect(await inviteEmail(db.current!.client, "new@example.com")).toEqual({ outcome: "has-password", mailed: false });
    expect(mailer.sent).toHaveLength(1);
    expect(db.current!.tables.password_credentials[0]).toEqual(before);
  });

  it("reports a mail that did not go out, and keeps it on the access list until a resend works", async () => {
    mailer.ok = false;
    expect(await inviteEmail(db.current!.client, "new@example.com")).toEqual({ outcome: "invited", mailed: false });
    expect(db.current!.tables.access_allowlist[0].note).toBe("invited, mail not sent");
    mailer.ok = true;
    expect(await inviteEmail(db.current!.client, "new@example.com")).toEqual({ outcome: "reinvited", mailed: true });
    expect(db.current!.tables.access_allowlist[0].note).toBe("invited");
  });

  it("only for an address every login and reset accepts, or an invitee could never get in", async () => {
    for (const odd of ["anna&ben@example.com", "user@example.xn--p1ai"]) {
      await expect(inviteEmail(db.current!.client, odd)).rejects.toBeInstanceOf(AccessError);
    }
    expect(db.current!.tables.users).toEqual([]);
  });

  it("settles that email's open request only once the account exists", async () => {
    db.current!.tables.access_requests = [{ id: "r1", email: "new@example.com", status: "pending" }];
    db.current!.state.failNext = { table: "users", op: "insert", code: "XX000" };
    await expect(inviteEmail(db.current!.client, "new@example.com")).rejects.toBeInstanceOf(AccessError);
    expect(db.current!.tables.access_requests[0].status).toBe("pending");
  });

  it("clears a stale 'mail not sent' once the account has its own password", async () => {
    mailer.ok = false;
    await inviteEmail(db.current!.client, "new@example.com");
    db.current!.tables.password_credentials[0].must_change_password = false; // set through the inbox reset
    expect(await inviteEmail(db.current!.client, "new@example.com")).toEqual({ outcome: "has-password", mailed: false });
    expect(db.current!.tables.access_allowlist[0].note).toBe("invited");
  });

  it("directly settles that email's open request, so approving it later mails no second password", async () => {
    db.current!.tables.access_requests = [{ id: "r1", email: "new@example.com", status: "pending" }];
    await inviteEmail(db.current!.client, "new@example.com");
    expect(db.current!.tables.access_requests[0].status).toBe("approved");
    await expect(approveRequest(db.current!.client, "r1")).rejects.toMatchObject({ status: 404 });
    expect(mailer.sent).toHaveLength(1);
  });

  it("leaves no account behind when its credential cannot be written", async () => {
    db.current!.state.failNext = { table: "password_credentials", op: "insert", code: "XX000" };
    await expect(inviteEmail(db.current!.client, "new@example.com")).rejects.toMatchObject({ status: 503 });
    db.current!.state.failNext = { table: "password_credentials", op: "insert", code: "23505" };
    await expect(inviteEmail(db.current!.client, "new@example.com")).rejects.toMatchObject({ status: 409 });
    expect(db.current!.tables.users).toEqual([]);
    expect(mailer.sent).toEqual([]);
  });

  it("must be an email address", async () => {
    await expect(inviteEmail(db.current!.client, "not an email")).rejects.toBeInstanceOf(AccessError);
    expect(db.current!.tables.access_allowlist).toEqual([]);
    expect(db.current!.tables.users).toEqual([]);
  });
});

describe("the one-time password", () => {
  it("is 20 letters from a 32-letter alphabet without look-alikes: 100 bits", () => {
    const seen = new Set(Array.from({ length: 200 }, () => oneTimePassword()));
    expect(seen.size).toBe(200);
    for (const p of seen) expect(p).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{20}$/);
  });
});

describe("an access request", () => {
  it("approved: its email is invited and the request is done; it cannot be approved twice", async () => {
    db.current!.tables.access_requests = [{ id: "r1", email: "applicant@example.com", status: "pending" }];
    expect(await approveRequest(db.current!.client, "r1")).toEqual({ outcome: "invited", mailed: true });
    expect(db.current!.tables.access_requests[0].status).toBe("approved");
    expect(mailer.sent[0].to).toBe("applicant@example.com");
    await expect(approveRequest(db.current!.client, "r1")).rejects.toMatchObject({ status: 404 });
  });

  it("approved twice at once mails one password: the request is claimed first", async () => {
    db.current!.tables.access_requests = [{ id: "r1", email: "applicant@example.com", status: "pending" }];
    const results = await Promise.allSettled([approveRequest(db.current!.client, "r1"), approveRequest(db.current!.client, "r1")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(mailer.sent).toHaveLength(1);
  });

  it("stays settled when another invite for the email just created the account", async () => {
    db.current!.tables.access_requests = [{ id: "r1", email: "applicant@example.com", status: "pending" }];
    db.current!.state.failNext = { table: "password_credentials", op: "insert", code: "23505" };
    await expect(approveRequest(db.current!.client, "r1")).rejects.toMatchObject({ status: 409 });
    expect(db.current!.tables.access_requests[0].status).toBe("approved");
  });

  it("says so when its invite fails and it cannot be reopened", async () => {
    // The form takes looser addresses than the invite: this one fails before any write.
    db.current!.tables.access_requests = [{ id: "r1", email: "anna&ben@example.com", status: "pending" }];
    db.current!.state.failNext = { table: "access_requests", op: "update", code: "XX000", skip: 1 };
    await expect(approveRequest(db.current!.client, "r1")).rejects.toThrow(/could not be reopened/);
  });

  it("goes back to pending when its invite fails", async () => {
    db.current!.tables.access_requests = [{ id: "r1", email: "applicant@example.com", status: "pending" }];
    db.current!.state.failNext = { table: "users", op: "insert", code: "XX000" };
    await expect(approveRequest(db.current!.client, "r1")).rejects.toBeInstanceOf(AccessError);
    expect(db.current!.tables.access_requests[0].status).toBe("pending");
  });

  it("rejected: it leaves the queue, nobody is mailed or let in, and it cannot be approved after", async () => {
    db.current!.tables.access_requests = [{ id: "r1", email: "applicant@example.com", status: "pending" }];
    expect(await rejectRequest(db.current!.client, "r1")).toEqual({ rejected: true });
    expect(db.current!.tables.access_requests[0].status).toBe("rejected");
    expect(db.current!.tables.access_allowlist).toEqual([]);
    expect(db.current!.tables.users).toEqual([]);
    expect(mailer.sent).toEqual([]);
    await expect(rejectRequest(db.current!.client, "r1")).rejects.toMatchObject({ status: 404 });
    await expect(approveRequest(db.current!.client, "r1")).rejects.toMatchObject({ status: 404 });
    expect((await loadAccess(db.current!.client)).requests).toEqual([]);
  });

  it("approved cannot be rejected after: its account exists", async () => {
    db.current!.tables.access_requests = [{ id: "r1", email: "applicant@example.com", status: "pending" }];
    await approveRequest(db.current!.client, "r1");
    await expect(rejectRequest(db.current!.client, "r1")).rejects.toMatchObject({ status: 404 });
    expect(db.current!.tables.access_requests[0].status).toBe("approved");
  });

  it("is listed for the admin while pending, beside the access list; a mod sees none of it", async () => {
    expect(await accessFor(db.current!.client, "mod")).toBeNull();
    expect(await accessFor(db.current!.client, "admin")).toEqual({ requests: [], allowlist: [] });
    db.current!.tables.access_requests = [
      { id: "r1", email: "a@example.com", about: "hi", socials: null, status: "pending" },
      { id: "r2", email: "b@example.com", about: "hey", socials: null, status: "approved" },
    ];
    db.current!.tables.access_allowlist = [{ id: "l1", kind: "wallet", value: SOL, note: null }];
    const access = await loadAccess(db.current!.client);
    expect(access.requests.map((r) => r.id)).toEqual(["r1"]);
    expect(access.allowlist.map((r) => r.value)).toEqual([SOL]);
  });
});

describe("an invited wallet", () => {
  it("goes on the access list only, once; it must be a Solana or EVM address", async () => {
    expect(await inviteWallet(db.current!.client, ` ${SOL} `)).toEqual({ listed: true });
    expect(await inviteWallet(db.current!.client, SOL)).toEqual({ listed: false });
    expect(await inviteWallet(db.current!.client, "0x" + "ab".repeat(20))).toEqual({ listed: true });
    await expect(inviteWallet(db.current!.client, "not-a-wallet")).rejects.toBeInstanceOf(AccessError);
    expect(db.current!.tables.access_allowlist.map((r) => r.kind)).toEqual(["wallet", "wallet"]);
    expect(db.current!.tables.users).toEqual([]);
    expect(mailer.sent).toEqual([]);
  });
});

describe("the admin route", () => {
  const ADMIN = "33333333-3333-4333-8333-333333333333";
  const asRole = (role: string) => {
    db.current!.tables.users = [{ id: ADMIN, role }];
    caller.userId = ADMIN;
  };

  it("lets an admin invite; a mod grants nothing", async () => {
    asRole("mod");
    const refused = await admin(post("/api/admin", { resource: "access", action: "inviteEmail", email: "new@example.com" }, "tok"));
    expect(refused.status).toBe(403);
    expect(db.current!.tables.access_allowlist).toEqual([]);
    expect(mailer.sent).toEqual([]);

    asRole("admin");
    const ok = await admin(post("/api/admin", { resource: "access", action: "inviteEmail", email: "new@example.com" }, "tok"));
    expect(await ok.json()).toEqual({ outcome: "invited", mailed: true });
  });

  it("lets an admin reject a request; a mod cannot", async () => {
    db.current!.tables.access_requests = [{ id: "r1", email: "applicant@example.com", status: "pending" }];
    asRole("mod");
    expect((await admin(post("/api/admin", { resource: "access", action: "reject", id: "r1" }, "tok"))).status).toBe(403);
    expect(db.current!.tables.access_requests[0].status).toBe("pending");
    asRole("admin");
    expect(await (await admin(post("/api/admin", { resource: "access", action: "reject", id: "r1" }, "tok"))).json()).toEqual({ rejected: true });
  });

  it("answers a refusal with its reason and status", async () => {
    asRole("admin");
    const res = await admin(post("/api/admin", { resource: "access", action: "inviteWallet", address: "nope" }, "tok"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/wallet address/);
  });
});
