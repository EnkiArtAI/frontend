import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb, type FakeDb } from "./_fake-supabase";

/** SOC-7 backend: connected accounts, password set, Instagram handle. */
// password-auth derives its decoy hash at import time, so the pepper must exist before the route loads.
const state = await vi.hoisted(async () => {
  const { randomBytes } = await import("node:crypto");
  process.env.AUTH_PEPPER = randomBytes(32).toString("base64");
  return { db: null as unknown as FakeDb };
});
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => state.db.client }));
import { GET as listIdentities } from "../../app/api/auth/identities/route";
import { DELETE as removeIdentity } from "../../app/api/auth/identities/[provider]/route";
import { POST as setPassword } from "../../app/api/auth/password/set/route";
import { GET as listSocials, POST as setSocial, DELETE as removeSocial } from "../../app/api/users/socials/route";

const UUID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const session = { token: "tok", wallet_address: UUID, wallet_type: "password", expires_at: "2999-01-01T00:00:00.000Z" };
const google = { provider: "google", subject: "g1", user_id: UUID, email: "kev@example.com", email_verified: true, handle: null };
const x = { provider: "x", subject: "x1", user_id: UUID, email: null, email_verified: false, handle: "kirikev" };

const req = (path: string, init: { method?: string; body?: unknown } = {}) =>
  new NextRequest(`https://enki.test${path}`, {
    method: init.method ?? "GET",
    headers: { "X-Session-Token": "tok", "Content-Type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });

beforeEach(() => { state.db = fakeDb({ auth_sessions: [session] }); });

describe("GET /api/auth/identities", () => {
  it("lists providers with handles plus hasPassword and hasWallet", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [google, x], user_wallets: [{ user_id: UUID, address: "So1", removed_at: null }] });
    const body = await (await listIdentities(req("/api/auth/identities"))).json();
    expect(body).toMatchObject({ hasPassword: false, hasWallet: true });
    expect(body.identities.map((i: { provider: string; handle: string | null }) => [i.provider, i.handle])).toEqual([["google", null], ["x", "kirikev"]]);
  });

  it("401s without a session and still answers when auth_identities is missing", async () => {
    expect((await listIdentities(new NextRequest("https://enki.test/api/auth/identities"))).status).toBe(401);
    state.db = fakeDb({ auth_sessions: [session], password_credentials: [{ user_id: UUID, email: "k@e.c" }] }, { auth_identities: { message: "Could not find the table", code: "PGRST205" } });
    expect(await (await listIdentities(req("/api/auth/identities"))).json()).toMatchObject({ identities: [], hasPassword: true });
  });
});

describe("DELETE /api/auth/identities/[provider]", () => {
  it("refuses to remove the last way to sign in", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [x] });
    const res = await removeIdentity(req("/api/auth/identities/x", { method: "DELETE" }), ctx("x"));
    expect(res.status).toBe(409);
    expect(state.db.tables.auth_identities).toHaveLength(1);
    // A wallet is provisioned from a session and cannot open one: it never counts.
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [x], user_wallets: [{ user_id: UUID, address: "So1", removed_at: null }] });
    expect((await removeIdentity(req("/api/auth/identities/x", { method: "DELETE" }), ctx("x"))).status).toBe(409);
  });

  it("removes one when a password or another provider remains", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [x], password_credentials: [{ user_id: UUID, email: "k@e.c" }] });
    expect((await removeIdentity(req("/api/auth/identities/x", { method: "DELETE" }), ctx("x"))).status).toBe(200);
    expect(state.db.tables.auth_identities).toEqual([]);

    state.db = fakeDb({ auth_sessions: [session], auth_identities: [google, x] });
    expect((await removeIdentity(req("/api/auth/identities/google", { method: "DELETE" }), ctx("google"))).status).toBe(200);
    expect(state.db.tables.auth_identities).toEqual([expect.objectContaining({ provider: "x" })]);
  });

  it("404s a provider that is not connected or not known", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [x], password_credentials: [{ user_id: UUID, email: "k@e.c" }] });
    expect((await removeIdentity(req("/api/auth/identities/google", { method: "DELETE" }), ctx("google"))).status).toBe(404);
    expect((await removeIdentity(req("/api/auth/identities/facebook", { method: "DELETE" }), ctx("facebook"))).status).toBe(404);
  });
});

describe("POST /api/auth/password/set", () => {
  it("only for accounts without a password", async () => {
    state.db = fakeDb({ auth_sessions: [session], password_credentials: [{ user_id: UUID, email: "k@e.c" }] });
    expect((await setPassword(req("/api/auth/password/set", { method: "POST", body: { password: "longenough" } }))).status).toBe(409);
  });

  it("takes the provider's email over the body and hashes like register", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [google] });
    const res = await setPassword(req("/api/auth/password/set", { method: "POST", body: { password: "longenough", email: "other@example.com" } }));
    expect(res.status).toBe(200);
    expect(state.db.tables.password_credentials).toEqual([
      expect.objectContaining({ user_id: UUID, email: "kev@example.com", pw_hash: expect.any(String), pw_salt: expect.any(String) }),
    ]);
    expect(state.db.tables.password_credentials[0].pw_hash).not.toContain("longenough");
    expect(state.db.ops).not.toContain("users.update");
  });

  it("needs an email from somewhere, and writes a body email onto the users row unverified", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [x] });
    expect((await setPassword(req("/api/auth/password/set", { method: "POST", body: { password: "longenough" } }))).status).toBe(400);
    expect(state.db.tables.password_credentials ?? []).toEqual([]);

    state.db = fakeDb({ auth_sessions: [session], auth_identities: [x], users: [{ id: UUID }] });
    const res = await setPassword(req("/api/auth/password/set", { method: "POST", body: { password: "longenough", email: "Kev@Example.com" } }));
    expect(res.status).toBe(200);
    expect(state.db.tables.password_credentials[0].email).toBe("kev@example.com");
    expect(state.db.tables.users[0]).toMatchObject({ email_lookup_hash: expect.stringMatching(/^[0-9a-f]{64}$/), email_verified_at: null });
  });

  it("refuses an email another password account owns", async () => {
    state.db = fakeDb({ auth_sessions: [session], auth_identities: [google], password_credentials: [{ user_id: "other", email: "kev@example.com" }] });
    expect((await setPassword(req("/api/auth/password/set", { method: "POST", body: { password: "longenough" } }))).status).toBe(409);
  });
});

describe("/api/users/socials", () => {
  it("upserts one Instagram handle per user and lists it", async () => {
    state.db = fakeDb({ auth_sessions: [session] });
    expect((await setSocial(req("/api/users/socials", { method: "POST", body: { provider: "instagram", handle: "@Kev.Art" } }))).status).toBe(200);
    expect((await setSocial(req("/api/users/socials", { method: "POST", body: { provider: "instagram", handle: "kevart2" } }))).status).toBe(200);
    expect(state.db.tables.user_socials).toEqual([expect.objectContaining({ user_id: UUID, provider: "instagram", handle: "kevart2", profile_url: "https://instagram.com/kevart2" })]);
    expect(await (await listSocials(req("/api/users/socials"))).json()).toEqual({ socials: [{ provider: "instagram", handle: "kevart2", profileUrl: "https://instagram.com/kevart2" }] });
  });

  it("rejects other providers and malformed handles, and removes on DELETE", async () => {
    state.db = fakeDb({ auth_sessions: [session], user_socials: [{ id: "s1", user_id: UUID, provider: "instagram", handle: "kev" }] });
    expect((await setSocial(req("/api/users/socials", { method: "POST", body: { provider: "tiktok", handle: "kev" } }))).status).toBe(400);
    expect((await setSocial(req("/api/users/socials", { method: "POST", body: { provider: "instagram", handle: "kev art" } }))).status).toBe(400);
    expect((await setSocial(req("/api/users/socials", { method: "POST", body: { provider: "instagram", handle: "https://instagram.com/kev" } }))).status).toBe(400);
    expect(state.db.tables.user_socials[0].handle).toBe("kev");
    expect((await removeSocial(req("/api/users/socials", { method: "DELETE", body: { provider: "instagram" } }))).status).toBe(200);
    expect(state.db.tables.user_socials).toEqual([]);
  });
});
