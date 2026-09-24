import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { fakeDb, type FakeDb } from "./_fake-supabase";
import { signState, STATE_COOKIE, type ProviderIdentity } from "@/lib/auth/oauth";

const state = vi.hoisted(() => ({ db: null as unknown as FakeDb, identity: null as unknown as ProviderIdentity }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => state.db.client }));
vi.mock("@/lib/auth/oauth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth/oauth")>();
  return { ...actual, completeAuth: vi.fn(async () => state.identity) };
});

import { GET as callback } from "../../app/api/auth/oauth/[provider]/callback/route";
import { GET as start, POST as startLink } from "../../app/api/auth/oauth/[provider]/start/route";

const UUID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });

beforeAll(() => {
  process.env.AUTH_PEPPER = randomBytes(32).toString("base64");
  process.env.X_OAUTH_CLIENT_ID = "x-client";
  process.env.X_OAUTH_CLIENT_SECRET = "x-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://enki.test";
  process.env.TEAM_ACCESS_CODE = "team-code";
});
beforeEach(() => {
  state.db = fakeDb({ access_allowlist: [{ kind: "x", value: "kirikev" }] });
  state.identity = { provider: "x", subject: "x1", email: null, emailVerified: false, handle: "kirikev", displayName: "Kev", avatarUrl: null };
});

async function callbackWith(cookie: string | null, query: Record<string, string>) {
  const url = new URL("https://enki.test/api/auth/oauth/x/callback");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const req = new NextRequest(url, { headers: cookie ? { cookie: `${STATE_COOKIE}=${cookie}` } : {} });
  return callback(req, ctx("x"));
}
const fragment = (res: Response) => new URLSearchParams(new URL(res.headers.get("location")!).hash.slice(1));
const cookies = (res: Response) => res.headers.getSetCookie();

describe("start", () => {
  it("302s to X with the state cookie set, httpOnly and scoped to the oauth routes", async () => {
    const res = await start(new NextRequest("https://enki.test/api/auth/oauth/x/start?next=/profile"), ctx("x"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/x\.com\/i\/oauth2\/authorize\?/);
    const c = cookies(res).find((c) => c.startsWith(`${STATE_COOKIE}=`))!;
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/Path=\/api\/auth\/oauth/);
    expect(c).toMatch(/SameSite=lax/i);
  });

  it("404s an unknown provider and refuses a link without a session", async () => {
    const res = await start(new NextRequest("https://enki.test/api/auth/oauth/facebook/start"), ctx("facebook"));
    expect(res.status).toBe(404);
    const link = await startLink(new NextRequest("https://enki.test/api/auth/oauth/x/start", { method: "POST" }), ctx("x"));
    expect(link.status).toBe(401);
  });

  it("sends the visitor to the error page when the provider is not configured", async () => {
    const saved = process.env.X_OAUTH_CLIENT_SECRET;
    delete process.env.X_OAUTH_CLIENT_SECRET;
    const res = await start(new NextRequest("https://enki.test/api/auth/oauth/x/start"), ctx("x"));
    process.env.X_OAUTH_CLIENT_SECRET = saved;
    expect(res.status).toBe(302);
    expect(fragment(res).get("error")).toBe("not_configured");
  });
});

describe("callback", () => {
  const good = () => signState({ provider: "x", intent: { kind: "login" }, next: "/profile", state: "s1", nonce: "n1", verifier: "v1" });

  it("refuses a missing, tampered or foreign cookie and a wrong state, clearing the cookie each time", async () => {
    const cookie = await good();
    for (const [c, q] of [
      [null, { state: "s1", code: "c" }],
      [cookie.slice(0, -2) + "xx", { state: "s1", code: "c" }],
      [cookie, { state: "other", code: "c" }],
      [cookie, { code: "c" }],
      [await signState({ provider: "google", intent: { kind: "login" }, next: "/", state: "s1", nonce: "n1", verifier: "v1" }), { state: "s1", code: "c" }],
    ] as const) {
      const res = await callbackWith(c, q);
      expect(res.status).toBe(302);
      expect(fragment(res).get("error")).toBe("state_mismatch");
      expect(cookies(res).find((x) => x.startsWith(`${STATE_COOKIE}=`))).toMatch(/Max-Age=0/);
      expect(state.db.ops).not.toContain("auth_sessions.insert");
    }
  });

  it("mints a session and hands the token over in the fragment, never the query, with the gate cookie", async () => {
    const res = await callbackWith(await good(), { state: "s1", code: "c" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://enki.test/auth/complete");
    expect(loc.search).toBe("");
    const f = fragment(res);
    expect(f.get("token")).toBe(state.db.tables.auth_sessions[0].token);
    expect(f.get("next")).toBe("/profile");
    expect(f.get("banned")).toBeNull();
    expect(state.db.tables.auth_sessions[0]).toMatchObject({ wallet_type: "password", wallet_address: state.db.tables.users[0].id });
    expect(cookies(res).find((c) => c.startsWith("enki_team="))).toMatch(/enki_team=team-code/);
  });

  it("a banned user gets a session and banned=1 but no gate cookie", async () => {
    state.db = fakeDb({
      access_allowlist: [{ kind: "x", value: "kirikev" }],
      auth_identities: [{ provider: "x", subject: "x1", user_id: UUID }],
      bans: [{ id: "b1", user_id: UUID, reason: "spam", lifted_at: null, expires_at: null }],
    });
    const res = await callbackWith(await good(), { state: "s1", code: "c" });
    const f = fragment(res);
    expect(f.get("banned")).toBe("1");
    expect(f.get("token")).toBeTruthy();
    expect(cookies(res).find((c) => c.startsWith("enki_team="))).toBeUndefined();
  });

  it("a stranger off the whitelist is refused before any session exists", async () => {
    state.identity = { ...state.identity, handle: "nobody" };
    const res = await callbackWith(await good(), { state: "s1", code: "c" });
    expect(fragment(res).get("error")).toBe("not_whitelisted");
    expect(state.db.ops).not.toContain("auth_sessions.insert");
    expect(state.db.tables.users ?? []).toEqual([]);
  });

  it("answers 503 with the migration name when auth_identities is missing", async () => {
    state.db = fakeDb({}, { auth_identities: { message: "Could not find the table 'public.auth_identities' in the schema cache", code: "PGRST205" } });
    const res = await callbackWith(await good(), { state: "s1", code: "c" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("2026-09-24-auth-identities.sql");
  });
});
