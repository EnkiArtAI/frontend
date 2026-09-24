import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { randomBytes } from "node:crypto";
import { fakeDb } from "./_fake-supabase";
import {
  beginAuth,
  completeAuth,
  emailLookupHash,
  MissingTableError,
  OAuthError,
  readState,
  resolveIdentity,
  sanitizeNext,
  signState,
  verifyGoogleIdToken,
  X_USERINFO,
  type ProviderIdentity,
  type StateClaims,
} from "@/lib/auth/oauth";

const UUID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

beforeAll(() => {
  process.env.AUTH_PEPPER = randomBytes(32).toString("base64");
  process.env.X_OAUTH_CLIENT_ID = "x-client";
  process.env.X_OAUTH_CLIENT_SECRET = "x-secret";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://enki.test";
});
beforeEach(() => { delete process.env.TEAM_ACCESS_CODE; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const claims = (over: Partial<StateClaims> = {}): StateClaims => ({
  provider: "x", intent: { kind: "login" }, next: "/home", state: "s1", nonce: "n1", verifier: "v1", ...over,
});

describe("sanitizeNext", () => {
  it("keeps a relative path and rejects everything that could leave the site", () => {
    expect(sanitizeNext("/profile?tab=wallet")).toBe("/profile?tab=wallet");
    expect(sanitizeNext("https://evil.example/x")).toBe("/home");
    expect(sanitizeNext("//evil.example")).toBe("/home");
    expect(sanitizeNext("/\\evil.example")).toBe("/home");
    expect(sanitizeNext("javascript:alert(1)")).toBe("/home");
    expect(sanitizeNext("/a b")).toBe("/home");
    expect(sanitizeNext(undefined)).toBe("/home");
    expect(sanitizeNext("")).toBe("/home");
  });
});

describe("state cookie", () => {
  it("round trips and binds to the provider", async () => {
    const cookie = await signState(claims());
    await expect(readState(cookie, "x")).resolves.toMatchObject({ state: "s1", nonce: "n1", verifier: "v1", intent: { kind: "login" } });
    await expect(readState(cookie, "google")).resolves.toBeNull();
  });

  it("refuses a tampered cookie", async () => {
    const cookie = await signState(claims());
    const [h, p, sig] = cookie.split(".");
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    await expect(readState(`${h}.${p}.${flipped}`, "x")).resolves.toBeNull();
    // payload swapped for another provider's state, signature kept
    const other = (await signState(claims({ state: "other" }))).split(".")[1];
    await expect(readState(`${h}.${other}.${sig}`, "x")).resolves.toBeNull();
    await expect(readState(undefined, "x")).resolves.toBeNull();
  });

  it("refuses an expired cookie", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T10:00:00Z"));
    const cookie = await signState(claims());
    vi.setSystemTime(new Date("2026-09-24T10:06:00Z"));
    await expect(readState(cookie, "x")).resolves.toBeNull();
  });

  it("sanitises the return path it carries", async () => {
    const cookie = await signState(claims({ next: "//evil.example" }));
    await expect(readState(cookie, "x")).resolves.toMatchObject({ next: "/home" });
  });
});

describe("google id_token", () => {
  const nonce = "nonce-1";
  async function idToken(payload: Record<string, unknown>, over: { iss?: string; aud?: string } = {}) {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = await exportJWK(publicKey);
    const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] });
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(over.iss ?? "https://accounts.google.com")
      .setAudience(over.aud ?? "google-client")
      .setSubject("g-123")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return { token, keys };
  }

  it("refuses a nonce that is not the one in our cookie", async () => {
    const { token, keys } = await idToken({ nonce, email: "a@b.c", email_verified: true });
    await expect(verifyGoogleIdToken(token, { clientId: "google-client", nonce: "other" }, keys)).rejects.toMatchObject({ code: "state_mismatch" });
  });

  it("refuses a wrong audience or issuer", async () => {
    const aud = await idToken({ nonce }, { aud: "someone-else" });
    await expect(verifyGoogleIdToken(aud.token, { clientId: "google-client", nonce }, aud.keys)).rejects.toMatchObject({ code: "provider_error" });
    const iss = await idToken({ nonce }, { iss: "https://accounts.example" });
    await expect(verifyGoogleIdToken(iss.token, { clientId: "google-client", nonce }, iss.keys)).rejects.toMatchObject({ code: "provider_error" });
  });

  it("only trusts email_verified when Google says true", async () => {
    const ok = await idToken({ nonce, email: "A@B.c", email_verified: true, name: "A", picture: "p" });
    await expect(verifyGoogleIdToken(ok.token, { clientId: "google-client", nonce }, ok.keys)).resolves.toMatchObject({
      provider: "google", subject: "g-123", email: "a@b.c", emailVerified: true, displayName: "A", avatarUrl: "p",
    });
    const no = await idToken({ nonce, email: "a@b.c", email_verified: "true" });
    await expect(verifyGoogleIdToken(no.token, { clientId: "google-client", nonce }, no.keys)).resolves.toMatchObject({ emailVerified: false });
  });
});

describe("x", () => {
  it("asks for the free scopes including users.email, no refresh token, and PKCE S256", async () => {
    const { url, cookie } = await beginAuth("x", { kind: "login" }, "/profile");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://x.com/i/oauth2/authorize");
    const scopes = u.searchParams.get("scope")!.split(" ");
    expect(scopes).toEqual(expect.arrayContaining(["users.read", "users.email", "tweet.read"]));
    expect(scopes).not.toContain("offline.access");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("https://enki.test/api/auth/oauth/x/callback");
    const st = await readState(cookie, "x");
    expect(st?.state).toBe(u.searchParams.get("state"));
    expect(st?.next).toBe("/profile");
  });

  it("never adds expansions or extra user.fields to users/me, and uses Basic auth on the token call", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("https://api.x.com/2/oauth2/token")) return Response.json({ access_token: "at" });
      if (url.startsWith("https://api.x.com/2/users/me")) return Response.json({ data: { id: "42", name: "Kev", username: "KiriKev", profile_image_url: "img" } });
      throw new Error(`unexpected ${url}`);
    });
    const id = await completeAuth(claims(), "code-1");
    expect(id).toEqual({ provider: "x", subject: "42", email: null, emailVerified: false, handle: "kirikev", displayName: "Kev", avatarUrl: "img" });
    const me = new URL(calls[1].url);
    expect(me.origin + me.pathname).toBe("https://api.x.com/2/users/me");
    expect([...me.searchParams.keys()]).toEqual(["user.fields"]);
    expect(me.searchParams.get("user.fields")).toBe("confirmed_email,profile_image_url");
    expect(X_USERINFO).not.toMatch(/expansions/);
    const tokenHeaders = calls[0].init?.headers as Record<string, string>;
    expect(tokenHeaders.Authorization).toBe(`Basic ${Buffer.from("x-client:x-secret").toString("base64")}`);
    expect(String(calls[0].init?.body)).toContain("code_verifier=v1");
  });
});

describe("resolveIdentity", () => {
  const google = (over: Partial<ProviderIdentity> = {}): ProviderIdentity => ({
    provider: "google", subject: "g1", email: "kev@example.com", emailVerified: true, handle: null, displayName: "Kev", avatarUrl: null, ...over,
  });
  const x = (over: Partial<ProviderIdentity> = {}): ProviderIdentity => ({
    provider: "x", subject: "x1", email: null, emailVerified: false, handle: "kirikev", displayName: "Kev", avatarUrl: null, ...over,
  });

  it("(a) a known identity resolves to its user without touching users", async () => {
    const db = fakeDb({ auth_identities: [{ provider: "google", subject: "g1", user_id: UUID }] });
    await expect(resolveIdentity(db.client, google(), { kind: "login" })).resolves.toEqual({ userId: UUID, banned: false, allowlisted: true });
    expect(db.ops).not.toContain("users.insert");
    expect(db.tables.auth_identities[0].last_login_at).toBeTruthy();
  });

  it("(b) never links to a password account by its unconfirmed email: a pre registered address does not capture the login", async () => {
    const ATTACKER = OTHER;
    const db = fakeDb({ password_credentials: [{ user_id: ATTACKER, email: "kev@example.com" }] });
    const r = await resolveIdentity(db.client, google(), { kind: "login" });
    expect(r.userId).not.toBe(ATTACKER);
    expect(db.ops).toContain("users.insert");
    expect(db.tables.auth_identities).toEqual([expect.objectContaining({ provider: "google", subject: "g1", user_id: r.userId })]);
    expect(db.tables.auth_identities[0].user_id).not.toBe(ATTACKER);
  });

  it("(b) links to a user whose email a provider verified, and only when both sides are verified", async () => {
    const verifiedUser = { id: UUID, email_lookup_hash: emailLookupHash("kev@example.com"), email_verified_at: "2026-09-24T00:00:00.000Z" };
    const db = fakeDb({ users: [verifiedUser] });
    await expect(resolveIdentity(db.client, x({ email: "kev@example.com", emailVerified: true }), { kind: "login" })).resolves.toMatchObject({ userId: UUID });
    expect(db.ops).not.toContain("users.insert");
    expect(db.tables.auth_identities).toEqual([expect.objectContaining({ provider: "x", subject: "x1", user_id: UUID })]);

    // the users row carries the email unverified (password/set wrote it) → stranger
    const unverifiedUser = fakeDb({ users: [{ ...verifiedUser, email_verified_at: null }] });
    expect((await resolveIdentity(unverifiedUser.client, google(), { kind: "login" })).userId).not.toBe(UUID);
    expect(unverifiedUser.ops).toContain("users.insert");

    // the identity's own email is unverified → stranger
    const unverifiedIdentity = fakeDb({ users: [verifiedUser] });
    expect((await resolveIdentity(unverifiedIdentity.client, google({ emailVerified: false }), { kind: "login" })).userId).not.toBe(UUID);
    expect(unverifiedIdentity.ops).toContain("users.insert");
  });

  it("(c) creates a user for a stranger, email columns only when there is an email", async () => {
    const db = fakeDb();
    const r = await resolveIdentity(db.client, x(), { kind: "login" });
    expect(db.tables.users).toEqual([expect.objectContaining({ id: r.userId, account_status: "active", display_name: "Kev" })]);
    expect(db.tables.users[0]).not.toHaveProperty("email_lookup_hash");
    expect(db.tables.auth_identities).toEqual([expect.objectContaining({ user_id: r.userId, handle: "kirikev" })]);

    const withMail = fakeDb();
    await resolveIdentity(withMail.client, google(), { kind: "login" });
    expect(withMail.tables.users[0]).toMatchObject({ email_lookup_hash: expect.stringMatching(/^[0-9a-f]{64}$/), email_verified_at: expect.any(String) });
  });

  it("rolls the users row back when the identity insert fails", async () => {
    const db = fakeDb({}, { "auth_identities.insert": { message: "boom", code: "XX000" } });
    await expect(resolveIdentity(db.client, x(), { kind: "login" })).rejects.toMatchObject({ message: "boom" });
    expect(db.tables.users).toEqual([]);
  });

  it("whitelist stage: a Google email must be listed, an X handle may be listed instead", async () => {
    process.env.TEAM_ACCESS_CODE = "code";
    const noMail = fakeDb({ access_allowlist: [{ kind: "email", value: "someone@else.com" }] });
    await expect(resolveIdentity(noMail.client, google(), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });
    expect(noMail.ops).not.toContain("users.insert");

    const listedMail = fakeDb({ access_allowlist: [{ kind: "email", value: "kev@example.com" }] });
    await expect(resolveIdentity(listedMail.client, google(), { kind: "login" })).resolves.toMatchObject({ allowlisted: true });

    // a listed address the provider has NOT verified opens nothing
    const unverifiedListed = fakeDb({ access_allowlist: [{ kind: "email", value: "kev@example.com" }] });
    await expect(resolveIdentity(unverifiedListed.client, google({ emailVerified: false }), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });
    expect(unverifiedListed.ops).not.toContain("users.insert");

    const noHandle = fakeDb({ access_allowlist: [{ kind: "x", value: "someoneelse" }] });
    await expect(resolveIdentity(noHandle.client, x(), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });

    const listedHandle = fakeDb({ access_allowlist: [{ kind: "x", value: "kirikev" }] });
    await expect(resolveIdentity(listedHandle.client, x({ handle: "KiriKev" }), { kind: "login" })).resolves.toMatchObject({ allowlisted: true });

    // a Google handle would never match the x kind
    const googleHandle = fakeDb({ access_allowlist: [{ kind: "x", value: "kirikev" }] });
    await expect(resolveIdentity(googleHandle.client, google({ email: null, emailVerified: false, handle: "kirikev" }), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });
  });

  it("whitelist stage: an identity connected from settings logs in by its account's listing", async () => {
    process.env.TEAM_ACCESS_CODE = "code";
    const linkedX = { provider: "x", subject: "x1", user_id: UUID, email: null, email_verified: false, handle: "kirikev" };
    const listed = [{ kind: "email", value: "kev@example.com" }];

    // the account's password email is listed, the X handle is not
    const viaPassword = fakeDb({ access_allowlist: listed, auth_identities: [linkedX], password_credentials: [{ user_id: UUID, email: "kev@example.com" }] });
    await expect(resolveIdentity(viaPassword.client, x(), { kind: "login" })).resolves.toMatchObject({ userId: UUID, allowlisted: true });

    // or another provider identity of the account carries a listed, verified email
    const google1 = { provider: "google", subject: "g1", user_id: UUID, email: "kev@example.com", email_verified: true, handle: null };
    const viaGoogle = fakeDb({ access_allowlist: listed, auth_identities: [linkedX, google1] });
    await expect(resolveIdentity(viaGoogle.client, x(), { kind: "login" })).resolves.toMatchObject({ userId: UUID, allowlisted: true });

    // an unverified identity email does not count, nor does an account with nothing listed
    const unverified = fakeDb({ access_allowlist: listed, auth_identities: [linkedX, { ...google1, email_verified: false }] });
    await expect(resolveIdentity(unverified.client, x(), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });
    const nothing = fakeDb({ access_allowlist: [{ kind: "email", value: "someone@else.com" }], auth_identities: [linkedX], password_credentials: [{ user_id: UUID, email: "kev@example.com" }] });
    await expect(resolveIdentity(nothing.client, x(), { kind: "login" })).rejects.toMatchObject({ code: "not_whitelisted" });
  });

  it("a banned user still resolves, flagged, and stays allowlisted so the gate opens /banned", async () => {
    const db = fakeDb({
      auth_identities: [{ provider: "x", subject: "x1", user_id: UUID }],
      bans: [{ id: "b1", user_id: UUID, reason: "spam", lifted_at: null, expires_at: null }],
    });
    await expect(resolveIdentity(db.client, x(), { kind: "login" })).resolves.toEqual({ userId: UUID, banned: true, allowlisted: true });
  });

  it("(d) link attaches to the session user and refuses an identity owned by someone else", async () => {
    const db = fakeDb();
    await expect(resolveIdentity(db.client, x(), { kind: "link", userId: UUID })).resolves.toMatchObject({ userId: UUID, allowlisted: false });
    expect(db.tables.auth_identities).toEqual([expect.objectContaining({ user_id: UUID, subject: "x1" })]);
    expect(db.ops).not.toContain("users.insert");

    await expect(resolveIdentity(db.client, x(), { kind: "link", userId: OTHER })).rejects.toMatchObject({ code: "already_linked" });
    expect(db.tables.auth_identities).toHaveLength(1);

    const slotTaken = fakeDb({}, { "auth_identities.insert": { message: "duplicate key", code: "23505" } });
    await expect(resolveIdentity(slotTaken.client, x(), { kind: "link", userId: UUID })).rejects.toBeInstanceOf(OAuthError);
  });

  it("names the missing table instead of a cryptic failure", async () => {
    const db = fakeDb({}, { auth_identities: { message: "Could not find the table 'public.auth_identities' in the schema cache", code: "PGRST205" } });
    await expect(resolveIdentity(db.client, x(), { kind: "login" })).rejects.toBeInstanceOf(MissingTableError);
  });
});
