import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * MFA core (Kev, 2026-10-07): an authenticator app and an email code beside
 * the passkey, any of them enough for a step-up. What must hold: secrets and
 * codes never sit in the clear, a code works once, five wrong codes lock the
 * factor however fast they arrive, and the gate fails closed.
 */

const db = fakePostgrest();
const supabase = db.client;
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => supabase }));

const mails: { to: string; text: string }[] = [];
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: { to: string; text: string }) => { mails.push(m); return { ok: true }; } }));
const session = vi.hoisted(() => ({ userId: "u1" as string | null }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserWithBan: async () => ({ userId: session.userId, ban: null, wallet: null }) }));

process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");

import { beginTotp, beginEmail, checkCode, enrolledFactors, sendEmailCode, MAX_ATTEMPTS } from "../mfa";
import { totpCode } from "../totp";
import { requireStepUp, mintStepUpToken } from "../webauthn";
import { POST as stepUp, GET as factors } from "../../app/api/auth/stepup/route";
import { POST as emailCode } from "../../app/api/auth/stepup/email/route";

const U = "u1";
const factor = (kind: string) => db.tables.mfa_factors.find((r) => r.user_id === U && r.kind === kind)!;
const lastCode = () => mails.at(-1)!.text.match(/\b(\d{6})\b/)![1];
const scope = "delete-work:1a2b3c4d-1111-4222-8333-444455556666";

async function confirmedTotp() {
  const t = await beginTotp(supabase, U, "me");
  if (t === "exists") throw new Error("exists");
  expect(await checkCode(supabase, U, "totp", totpCode(t.secret), { confirm: true })).toBe("ok");
  return t.secret;
}

beforeEach(() => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  db.tables.webauthn_credentials = [];
  db.tables.mfa_factors = [];
  db.state.failing = null;
  db.state.pauseNextRead = null;
  mails.length = 0;
  session.userId = U;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("an authenticator app", () => {
  it("counts once confirmed with a code, and its secret is stored sealed", async () => {
    const t = await beginTotp(supabase, U, "me");
    if (t === "exists") throw new Error();
    expect(t.uri).toMatch(/^otpauth:\/\/totp\/Enki%20Art:me\?secret=/);
    expect(await enrolledFactors(supabase, U)).toEqual([]);
    expect(JSON.stringify(factor("totp"))).not.toContain(t.secret);
    expect(await checkCode(supabase, U, "totp", totpCode(t.secret))).toBe("none"); // pending does not step up
    expect(await checkCode(supabase, U, "totp", totpCode(t.secret), { confirm: true })).toBe("ok");
    expect(await enrolledFactors(supabase, U)).toEqual(["totp"]);
  });

  it("takes each code once", async () => {
    const secret = await confirmedTotp();
    vi.setSystemTime(new Date("2026-10-07T12:00:31Z"));
    const code = totpCode(secret);
    expect(await checkCode(supabase, U, "totp", code)).toBe("ok");
    expect(await checkCode(supabase, U, "totp", code)).toBe("wrong");
  });

  it("is not replaced while confirmed", async () => {
    await confirmedTotp();
    expect(await beginTotp(supabase, U, "me")).toBe("exists");
  });

  it("locks after five wrong codes, then refuses even the right one, and the next lock is twice as long", async () => {
    const secret = await confirmedTotp();
    for (let i = 1; i < MAX_ATTEMPTS; i++) expect(await checkCode(supabase, U, "totp", "000000")).toBe("wrong");
    expect(await checkCode(supabase, U, "totp", "000000")).toBe("locked");
    vi.setSystemTime(new Date("2026-10-07T12:01:00Z"));
    expect(await checkCode(supabase, U, "totp", totpCode(secret))).toBe("locked");
    expect(Date.parse(String(factor("totp").locked_until)) - Date.now()).toBe(14 * 60_000);

    vi.setSystemTime(new Date("2026-10-07T12:15:30Z"));
    for (let i = 0; i < MAX_ATTEMPTS; i++) await checkCode(supabase, U, "totp", "000000");
    expect(Date.parse(String(factor("totp").locked_until)) - Date.now()).toBe(30 * 60_000);
  });

  it("gives parallel guesses no extra tries", async () => {
    await confirmedTotp();
    const results = await Promise.all(Array.from({ length: 12 }, () => checkCode(supabase, U, "totp", "000000")));
    expect(results.filter((r) => r === "wrong" || r === "locked").length).toBeLessThanOrEqual(1);
    expect(Number(factor("totp").failed_attempts)).toBeLessThanOrEqual(1);
  });
});

describe("an email code", () => {
  it("proves the inbox at enrollment; the address and the code are stored sealed", async () => {
    expect(await beginEmail(supabase, U, "Me@Example.com")).toBe("sent");
    expect(mails[0].to).toBe("me@example.com");
    const row = JSON.stringify(factor("email"));
    expect(row).not.toContain("me@example.com");
    expect(row).not.toContain(lastCode());
    expect(await checkCode(supabase, U, "email", lastCode(), { confirm: true })).toBe("ok");
    expect(await enrolledFactors(supabase, U)).toEqual(["email"]);
  });

  it("works once, for ten minutes, and a new code replaces the last", async () => {
    await beginEmail(supabase, U, "me@example.com");
    await checkCode(supabase, U, "email", lastCode(), { confirm: true });

    vi.setSystemTime(new Date("2026-10-07T12:02:00Z"));
    expect(await sendEmailCode(supabase, U)).toBe("sent");
    const first = lastCode();
    vi.setSystemTime(new Date("2026-10-07T12:03:30Z"));
    expect(await sendEmailCode(supabase, U)).toBe("sent");
    expect(await checkCode(supabase, U, "email", first)).toBe("wrong");
    const second = lastCode();
    expect(await checkCode(supabase, U, "email", second)).toBe("ok");
    expect(await checkCode(supabase, U, "email", second)).toBe("wrong");

    vi.setSystemTime(new Date("2026-10-07T12:05:00Z"));
    await sendEmailCode(supabase, U);
    vi.setSystemTime(new Date("2026-10-07T12:15:01Z"));
    expect(await checkCode(supabase, U, "email", lastCode())).toBe("wrong");
  });

  it("is sent at most once a minute and five times a day", async () => {
    await beginEmail(supabase, U, "me@example.com");
    expect(await sendEmailCode(supabase, U)).toBe("cooldown");
    for (let m = 2; m <= 5; m++) {
      vi.setSystemTime(new Date(`2026-10-07T12:0${m}:00Z`));
      expect(await sendEmailCode(supabase, U)).toBe("sent");
    }
    vi.setSystemTime(new Date("2026-10-07T12:09:00Z"));
    expect(await sendEmailCode(supabase, U)).toBe("daily_cap");
    vi.setSystemTime(new Date("2026-10-08T00:01:00Z"));
    expect(await sendEmailCode(supabase, U)).toBe("sent");
  });

  it("has no code outlive a lock", async () => {
    await beginEmail(supabase, U, "me@example.com");
    const code = lastCode();
    for (let i = 0; i < MAX_ATTEMPTS; i++) await checkCode(supabase, U, "email", "000000", { confirm: true });
    vi.setSystemTime(new Date("2026-10-07T12:20:00Z"));
    expect(await checkCode(supabase, U, "email", code, { confirm: true })).toBe("wrong");
  });
});

/** Hands the next read of the factor row its snapshot now and the caller the answer later. */
function staleRead() {
  let release!: () => void;
  db.state.pauseNextRead = { table: "mfa_factors", until: new Promise<void>((r) => { release = r; }) };
  return () => release();
}

describe("racing requests", () => {
  it("spend a code once, however many carry it at the same time", async () => {
    const secret = await confirmedTotp();
    vi.setSystemTime(new Date("2026-10-07T12:00:31Z"));
    const code = totpCode(secret);
    const release = staleRead();
    const late = checkCode(supabase, U, "totp", code);
    expect(await checkCode(supabase, U, "totp", code)).toBe("ok");
    release();
    expect(await late).not.toBe("ok");
  });

  it("spend an email code once too", async () => {
    await beginEmail(supabase, U, "me@example.com");
    await checkCode(supabase, U, "email", lastCode(), { confirm: true });
    vi.setSystemTime(new Date("2026-10-07T12:02:00Z"));
    await sendEmailCode(supabase, U);
    const code = lastCode();
    const release = staleRead();
    const late = checkCode(supabase, U, "email", code);
    expect(await checkCode(supabase, U, "email", code)).toBe("ok");
    release();
    expect(await late).not.toBe("ok");
  });

  it("get no guess in while the factor is locked, even from a read made before the lock", async () => {
    const secret = await confirmedTotp();
    vi.setSystemTime(new Date("2026-10-07T12:00:31Z"));
    const release = staleRead();
    const late = checkCode(supabase, U, "totp", totpCode(secret));
    for (let i = 0; i < MAX_ATTEMPTS; i++) await checkCode(supabase, U, "totp", "000000");
    release();
    expect(await late).not.toBe("ok");
    expect(Number(factor("totp").lockouts)).toBe(1);
  });

  it("send one code a minute even when sends race", async () => {
    await beginEmail(supabase, U, "me@example.com");
    vi.setSystemTime(new Date("2026-10-07T12:02:00Z"));
    mails.length = 0;
    const release = staleRead();
    const late = sendEmailCode(supabase, U);
    expect(await sendEmailCode(supabase, U)).toBe("sent");
    release();
    expect(await late).toBe("cooldown");
    expect(mails).toHaveLength(1);
  });

  it("never confirm a re-begun authenticator with the old secret's code", async () => {
    const first = await beginTotp(supabase, U, "me");
    if (first === "exists") throw new Error();
    const release = staleRead();
    const late = checkCode(supabase, U, "totp", totpCode(first.secret), { confirm: true });
    await beginTotp(supabase, U, "me");
    release();
    expect(await late).not.toBe("ok");
    expect(factor("totp").confirmed_at ?? null).toBeNull();
  });
});

describe("the step-up gate", () => {
  const req = (token?: string) => new NextRequest("http://enki.test/x", { headers: token ? { "X-StepUp-Token": token } : {} });

  it("fails closed without a user and on a broken lookup", async () => {
    expect((await requireStepUp(req(), null, scope))!.status).toBe(401);
    db.state.failing = { table: "webauthn_credentials", code: "08006" };
    expect((await requireStepUp(req(), U, scope))!.status).toBe(503);
    db.state.failing = { table: "mfa_factors", code: "08006" };
    expect((await requireStepUp(req(), U, scope))!.status).toBe(503);
  });

  it("lets a user without a factor through, unless the action is mandatory", async () => {
    expect(await requireStepUp(req(), U, scope)).toBeNull();
    const res = await requireStepUp(req(), U, scope, { mandatory: true });
    expect(res!.status).toBe(403);
    expect((await res!.json()).enroll).toBe(true);
  });

  it("asks a user with any factor for a token of this scope, naming the factors", async () => {
    await confirmedTotp();
    const res = await requireStepUp(req(), U, scope);
    expect(res!.status).toBe(401);
    expect((await res!.json()).factors).toEqual(["totp"]);
    const other = await mintStepUpToken(U, "delete-work:9a2b3c4d-1111-4222-8333-444455556666");
    expect((await requireStepUp(req(other), U, scope))!.status).toBe(401);
    expect(await requireStepUp(req(await mintStepUpToken(U, scope)), U, scope)).toBeNull();
  });

  it("treats a factors table that is not migrated yet as empty, and nothing else", async () => {
    db.tables.webauthn_credentials.push({ id: "p", user_id: U });
    db.state.failing = { table: "mfa_factors", code: "PGRST205" };
    expect(await enrolledFactors(supabase, U)).toEqual(["passkey"]);
    db.state.failing = { table: "mfa_factors", code: "42501" };
    await expect(enrolledFactors(supabase, U)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("the step-up routes", () => {
  const post = (body: unknown) => stepUp(new NextRequest("http://enki.test/api/auth/stepup", { method: "POST", body: JSON.stringify(body) }));

  it("mint a token for the scope with a right code, and only then", async () => {
    const secret = await confirmedTotp();
    vi.setSystemTime(new Date("2026-10-07T12:00:31Z"));
    expect((await post({ scope, factor: "totp", code: "000000" })).status).toBe(401);
    const res = await post({ scope, factor: "totp", code: totpCode(secret) });
    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect(await requireStepUp(new NextRequest("http://enki.test/x", { headers: { "X-StepUp-Token": token } }), U, scope)).toBeNull();
  });

  it("refuse an unknown scope, a missing session and a locked factor", async () => {
    await confirmedTotp();
    expect((await post({ scope: "anything", factor: "totp", code: "123456" })).status).toBe(400);
    session.userId = null;
    expect((await post({ scope, factor: "totp", code: "123456" })).status).toBe(401);
    session.userId = U;
    for (let i = 0; i < MAX_ATTEMPTS; i++) await post({ scope, factor: "totp", code: "000000" });
    expect((await post({ scope, factor: "totp", code: "000000" })).status).toBe(429);
  });

  it("list the user's factors and send an email code only to a confirmed address", async () => {
    await beginEmail(supabase, U, "me@example.com");
    const send = () => emailCode(new NextRequest("http://enki.test/api/auth/stepup/email", { method: "POST" }));
    expect((await send()).status).toBe(404);
    await checkCode(supabase, U, "email", lastCode(), { confirm: true });
    vi.setSystemTime(new Date("2026-10-07T12:05:00Z"));
    expect((await send()).status).toBe(200);
    expect(await (await factors(new NextRequest("http://enki.test/api/auth/stepup"))).json()).toEqual({ factors: ["email"] });
  });
});
