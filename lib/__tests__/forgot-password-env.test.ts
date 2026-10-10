import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * ENV-01 (narrowed): in production, a missing RESEND_API_KEY must not let
 * forgot-password silently pretend to work — it previously always returned
 * {ok:true} and only logged the code to console when NODE_ENV !== "production",
 * so a real production misconfiguration left users with no code and no signal.
 * The fix must not create an email-enumeration oracle: the 503 has to fire
 * identically whether or not the given email has an account.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
const mails: unknown[] = [];
vi.mock("@/lib/mailer", () => ({ sendMail: async (m: unknown) => { mails.push(m); return { ok: true }; } }));

import { POST as forgot } from "../../app/api/auth/password/forgot/route";

const EMAIL_WITH_ACCOUNT = "has-account@example.com";
const EMAIL_WITHOUT_ACCOUNT = "no-account@example.com";
const post = (email: string) =>
  new NextRequest("http://enki.test/api/auth/password/forgot", {
    method: "POST",
    body: JSON.stringify({ email }),
  });

let prevNodeEnv: string | undefined;
let prevResendKey: string | undefined;

beforeEach(() => {
  db.current = fakePostgrest();
  db.current.tables.password_credentials = [{ user_id: "11111111-1111-4111-8111-111111111111", email: EMAIL_WITH_ACCOUNT }];
  db.current.tables.password_reset_tokens = [];
  mails.length = 0;
  prevNodeEnv = process.env.NODE_ENV;
  prevResendKey = process.env.RESEND_API_KEY;
});
afterEach(() => {
  vi.stubEnv("NODE_ENV", prevNodeEnv ?? "test");
  if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = prevResendKey;
  vi.unstubAllEnvs();
});

describe("forgot-password answers honestly when mail isn't configured", () => {
  it("DECISIVE: in production with no RESEND_API_KEY, refuses with 503 instead of pretending ok — for an email that has an account", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.RESEND_API_KEY;
    const res = await forgot(post(EMAIL_WITH_ACCOUNT));
    expect(res.status).toBe(503);
    expect(mails.length).toBe(0);
  });

  it("the same 503 fires for an email with NO account — proves this isn't an enumeration oracle", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.RESEND_API_KEY;
    const res = await forgot(post(EMAIL_WITHOUT_ACCOUNT));
    expect(res.status).toBe(503);
  });

  it("in production WITH a configured key, behaves as before: 200 ok and an email attempt for a real account", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.RESEND_API_KEY = "re_test";
    const res = await forgot(post(EMAIL_WITH_ACCOUNT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mails.length).toBe(1);
  });

  it("outside production, an unconfigured key still falls back to ok:true (the dev console-log path is untouched by this fix)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.RESEND_API_KEY;
    const res = await forgot(post(EMAIL_WITH_ACCOUNT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
