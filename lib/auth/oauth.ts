import { createHash, hkdfSync, randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { isEmailAllowed, isXHandleAllowed, whitelistStageActive } from "@/lib/allowlist";
import { encryptString } from "@/lib/crypto";
import { activeBanFor } from "@/lib/session-user";

/**
 * Sign in with Google and X on our own session model (Kev, 2026-09-23/24).
 *
 * A provider account is one row in auth_identities, keyed (provider, subject),
 * pointing at a users row. Login resolves that row, or links the identity to
 * the password account with the same verified email, or creates a user. The
 * session that comes out is the ordinary auth_sessions row every other login
 * mints (lib/user-session), so nothing downstream knows how the user got in.
 *
 * Everything the callback has to trust travels in ONE short lived signed
 * cookie: the CSRF state, the OpenID nonce and the PKCE verifier, bound to the
 * provider, the intent and the sanitised return path. Nothing is stored
 * server side between the two legs.
 */
export type Provider = "google" | "x";
export const PROVIDERS: readonly Provider[] = ["google", "x"];
export const isProvider = (p: string): p is Provider => (PROVIDERS as readonly string[]).includes(p);

export type Intent = { kind: "login" } | { kind: "link"; userId: string };

export type OAuthErrorCode = "not_whitelisted" | "provider_error" | "state_mismatch" | "already_linked" | "not_configured";
export class OAuthError extends Error {
  constructor(public readonly code: OAuthErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = "OAuthError";
  }
}

/** The auth_identities table is missing until the migration runs. */
export class MissingTableError extends Error {
  constructor(public readonly table: string) {
    super(`${table} table missing`);
    this.name = "MissingTableError";
  }
}
const isMissingTable = (err: unknown): boolean => {
  const e = err as { code?: unknown; message?: unknown } | null;
  return !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|Could not find the table/i.test(String(e.message ?? "")));
};

export const PROVIDER_LABEL: Record<Provider, string> = { google: "Google", x: "X" };

export const ENV_NAMES: Record<Provider, { id: string; secret: string }> = {
  google: { id: "GOOGLE_OAUTH_CLIENT_ID", secret: "GOOGLE_OAUTH_CLIENT_SECRET" },
  x: { id: "X_OAUTH_CLIENT_ID", secret: "X_OAUTH_CLIENT_SECRET" },
};

function providerConfig(provider: Provider): { clientId: string; clientSecret: string } {
  const clientId = process.env[ENV_NAMES[provider].id];
  const clientSecret = process.env[ENV_NAMES[provider].secret];
  if (!clientId || !clientSecret) throw new OAuthError("not_configured", `${ENV_NAMES[provider].id} / ${ENV_NAMES[provider].secret} not set`);
  return { clientId, clientSecret };
}

export const appUrl = (): string => (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3008").replace(/\/$/, "");
export const redirectUri = (provider: Provider): string => `${appUrl()}/api/auth/oauth/${provider}/callback`;

/**
 * The only shape a return path may take: one leading slash, then anything but
 * a second slash or backslash (a scheme relative //evil.example is a redirect
 * off site) and no whitespace. Everything else goes to /home.
 */
export const DEFAULT_NEXT = "/home";
export function sanitizeNext(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 512) return DEFAULT_NEXT;
  return /^\/(?![/\\])\S*$/.test(raw) ? raw : DEFAULT_NEXT;
}

// ── state cookie ───────────────────────────────────────────────────────────
export const STATE_COOKIE = "enki_oauth";
export const STATE_COOKIE_PATH = "/api/auth/oauth";
export const STATE_TTL_S = 5 * 60;

function stateKey(): Uint8Array {
  const p = process.env.AUTH_PEPPER;
  if (!p) throw new Error("AUTH_PEPPER not configured");
  return new Uint8Array(hkdfSync("sha256", Buffer.from(p, "base64"), new Uint8Array(0), Buffer.from("enki-oauth-v1"), 32));
}

export type StateClaims = {
  provider: Provider;
  intent: Intent;
  next: string;
  state: string;
  nonce: string;
  verifier: string;
};

export async function signState(claims: StateClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_S}s`)
    .sign(stateKey());
}

/** The claims, or null when the cookie is missing, tampered, expired or for another provider. */
export async function readState(cookie: string | undefined, provider: Provider): Promise<StateClaims | null> {
  if (!cookie) return null;
  try {
    const { payload } = await jwtVerify(cookie, stateKey());
    const c = payload as unknown as StateClaims;
    if (c.provider !== provider) return null;
    if (typeof c.state !== "string" || typeof c.nonce !== "string" || typeof c.verifier !== "string") return null;
    if (c.intent?.kind !== "login" && !(c.intent?.kind === "link" && typeof c.intent.userId === "string")) return null;
    return { provider, intent: c.intent, next: sanitizeNext(c.next), state: c.state, nonce: c.nonce, verifier: c.verifier };
  } catch {
    return null;
  }
}

// ── provider endpoints ─────────────────────────────────────────────────────
const GOOGLE_DISCOVERY = "https://accounts.google.com/.well-known/openid-configuration";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const X_AUTHORIZE = "https://x.com/i/oauth2/authorize";
const X_TOKEN = "https://api.x.com/2/oauth2/token";
/** Only the two fields we store. No expansions and no further user.fields:
    those move /2/users/me out of the free tier under Pay Per Use (X staff). */
export const X_USERINFO = "https://api.x.com/2/users/me?user.fields=confirmed_email,profile_image_url";

type GoogleDiscovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
let googleDiscovery: Promise<GoogleDiscovery> | null = null;
function discoverGoogle(): Promise<GoogleDiscovery> {
  googleDiscovery ??= fetch(GOOGLE_DISCOVERY)
    .then(async (r) => {
      if (!r.ok) throw new OAuthError("provider_error", `google discovery ${r.status}`);
      return (await r.json()) as GoogleDiscovery;
    })
    .catch((e) => {
      googleDiscovery = null;
      throw e;
    });
  return googleDiscovery;
}

const b64url = (b: Buffer) => b.toString("base64url");
const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

/** Authorize URL plus the signed cookie value the callback needs. */
export async function beginAuth(provider: Provider, intent: Intent, next: unknown): Promise<{ url: string; cookie: string }> {
  const { clientId } = providerConfig(provider);
  const claims: StateClaims = {
    provider,
    intent,
    next: sanitizeNext(next),
    state: b64url(randomBytes(24)),
    nonce: b64url(randomBytes(24)),
    verifier: b64url(randomBytes(32)),
  };
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri(provider),
    state: claims.state,
    code_challenge: pkceChallenge(claims.verifier),
    code_challenge_method: "S256",
  });
  let base: string;
  if (provider === "google") {
    base = (await discoverGoogle()).authorization_endpoint;
    params.set("scope", "openid email profile");
    params.set("nonce", claims.nonce);
  } else {
    base = X_AUTHORIZE;
    params.set("scope", "users.read tweet.read offline.access");
  }
  return { url: `${base}?${params}`, cookie: await signState(claims) };
}

export type ProviderIdentity = {
  provider: Provider;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

async function exchangeCode(provider: Provider, code: string, verifier: string): Promise<{ access_token?: string; id_token?: string }> {
  const { clientId, clientSecret } = providerConfig(provider);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(provider),
    code_verifier: verifier,
    client_id: clientId,
  });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  let endpoint: string;
  if (provider === "google") {
    endpoint = (await discoverGoogle()).token_endpoint;
    body.set("client_secret", clientSecret);
  } else {
    endpoint = X_TOKEN;
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }
  const res = await fetch(endpoint, { method: "POST", headers, body });
  if (!res.ok) throw new OAuthError("provider_error", `${provider} token endpoint ${res.status}`);
  return (await res.json()) as { access_token?: string; id_token?: string };
}

let googleKeys: JWTVerifyGetKey | null = null;
async function googleJwks(): Promise<JWTVerifyGetKey> {
  googleKeys ??= createRemoteJWKSet(new URL((await discoverGoogle()).jwks_uri));
  return googleKeys;
}

/** Google's id_token → identity. `keys` is injectable so tests verify against a local JWKS. */
export async function verifyGoogleIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string },
  keys?: JWTVerifyGetKey,
): Promise<ProviderIdentity> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, keys ?? (await googleJwks()), { issuer: GOOGLE_ISSUERS, audience: expected.clientId }));
  } catch (e) {
    throw new OAuthError("provider_error", `google id_token: ${e instanceof Error ? e.message : "invalid"}`);
  }
  if (payload.nonce !== expected.nonce) throw new OAuthError("state_mismatch", "nonce mismatch");
  if (typeof payload.sub !== "string" || !payload.sub) throw new OAuthError("provider_error", "google id_token without sub");
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : null;
  return {
    provider: "google",
    subject: payload.sub,
    email,
    emailVerified: !!email && payload.email_verified === true,
    handle: null,
    displayName: typeof payload.name === "string" ? payload.name : null,
    avatarUrl: typeof payload.picture === "string" ? payload.picture : null,
  };
}

async function fetchXIdentity(accessToken: string): Promise<ProviderIdentity> {
  const res = await fetch(X_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new OAuthError("provider_error", `x users/me ${res.status}`);
  const { data } = (await res.json()) as {
    data?: { id?: string; name?: string; username?: string; confirmed_email?: string; profile_image_url?: string };
  };
  if (!data?.id) throw new OAuthError("provider_error", "x users/me without id");
  const email = data.confirmed_email?.trim().toLowerCase() || null;
  return {
    provider: "x",
    subject: data.id,
    email,
    emailVerified: !!email,
    handle: data.username?.replace(/^@/, "").toLowerCase() ?? null,
    displayName: data.name ?? null,
    avatarUrl: data.profile_image_url ?? null,
  };
}

/** Code + verified state → who the provider says this is. */
export async function completeAuth(claims: StateClaims, code: string): Promise<ProviderIdentity> {
  const tokens = await exchangeCode(claims.provider, code, claims.verifier);
  if (claims.provider === "google") {
    if (!tokens.id_token) throw new OAuthError("provider_error", "google token response without id_token");
    return verifyGoogleIdToken(tokens.id_token, { clientId: providerConfig("google").clientId, nonce: claims.nonce });
  }
  if (!tokens.access_token) throw new OAuthError("provider_error", "x token response without access_token");
  return fetchXIdentity(tokens.access_token);
}

// ── identity → user ────────────────────────────────────────────────────────
export type Resolved = { userId: string; banned: boolean; allowlisted: boolean };

export const emailLookupHash = (email: string) => createHash("sha256").update(email.toLowerCase()).digest("hex");

/**
 * The users row columns an email fills. Ciphertext needs the field keyring
 * (FIELD_ENCRYPTION_KEY_B64); without it only the lookup hash is written and
 * the plaintext stays where every login table keeps it (auth_identities.email,
 * like password_credentials.email).
 */
export function emailColumns(email: string, verified: boolean): Record<string, string | null> {
  const cols: Record<string, string | null> = {
    email_lookup_hash: emailLookupHash(email),
    email_verified_at: verified ? new Date().toISOString() : null,
  };
  try {
    const enc = encryptString(email);
    Object.assign(cols, { email_ct: enc.encrypted, email_iv: enc.iv, email_tag: enc.authTag, email_kid: enc.kid ?? null });
  } catch (e) {
    console.warn("[oauth] email not encrypted into users:", e instanceof Error ? e.message : e);
  }
  return cols;
}

export async function identityAllowed(supabase: SupabaseClient, id: ProviderIdentity): Promise<boolean> {
  if (!whitelistStageActive()) return true;
  if (id.email && (await isEmailAllowed(supabase, id.email))) return true;
  return id.provider === "x" && !!id.handle && (await isXHandleAllowed(supabase, id.handle));
}

const identityRow = (id: ProviderIdentity) => ({
  email: id.email,
  email_verified: id.emailVerified,
  handle: id.handle,
  display_name: id.displayName,
  avatar_url: id.avatarUrl,
  last_login_at: new Date().toISOString(),
});

async function insertIdentity(supabase: SupabaseClient, userId: string, id: ProviderIdentity): Promise<void> {
  const { error } = await supabase
    .from("auth_identities")
    .insert({ provider: id.provider, subject: id.subject, user_id: userId, ...identityRow(id) });
  if (!error) return;
  if (isMissingTable(error)) throw new MissingTableError("auth_identities");
  if (error.code === "23505") throw new OAuthError("already_linked", "identity or provider slot taken");
  throw error;
}

/** The password account, or an already verified user, that owns this email. */
async function userByVerifiedEmail(supabase: SupabaseClient, email: string): Promise<string | null> {
  const { data: cred, error } = await supabase
    .from("password_credentials")
    .select("user_id")
    .eq("email", email)
    .maybeSingle();
  if (error) throw error;
  if (cred?.user_id) return cred.user_id as string;
  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id")
    .eq("email_lookup_hash", emailLookupHash(email))
    .not("email_verified_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (userErr) throw userErr;
  return (user?.id as string) ?? null;
}

async function createUser(supabase: SupabaseClient, id: ProviderIdentity): Promise<string> {
  const { data: user, error } = await supabase
    .from("users")
    .insert({
      account_status: "active",
      display_name: id.displayName,
      avatar_url: id.avatarUrl,
      ...(id.email ? emailColumns(id.email, id.emailVerified) : {}),
    })
    .select("id")
    .single();
  if (error || !user) throw error ?? new Error("users insert returned nothing");
  return user.id as string;
}

/**
 * (a) known identity → its user; (b) login with a verified email that a
 * password account owns → link there; (c) login, nobody → whitelist check,
 * then a fresh user; (d) link → attach to the session user, already_linked
 * when the identity belongs to someone else. Then the ban flag.
 */
export async function resolveIdentity(supabase: SupabaseClient, id: ProviderIdentity, intent: Intent): Promise<Resolved> {
  const { data: existing, error: lookupErr } = await supabase
    .from("auth_identities")
    .select("user_id")
    .eq("provider", id.provider)
    .eq("subject", id.subject)
    .maybeSingle();
  if (lookupErr) {
    if (isMissingTable(lookupErr)) throw new MissingTableError("auth_identities");
    throw lookupErr;
  }
  const touch = () =>
    supabase.from("auth_identities").update(identityRow(id)).eq("provider", id.provider).eq("subject", id.subject);

  let userId: string;
  let allowlisted = false;
  if (intent.kind === "link") {
    if (existing && existing.user_id !== intent.userId) throw new OAuthError("already_linked", "identity belongs to another user");
    userId = intent.userId;
    if (existing) await touch();
    else await insertIdentity(supabase, userId, id);
  } else {
    allowlisted = await identityAllowed(supabase, id);
    if (!allowlisted) throw new OAuthError("not_whitelisted");
    if (existing) {
      userId = existing.user_id as string;
      await touch();
    } else {
      const linked = id.emailVerified && id.email ? await userByVerifiedEmail(supabase, id.email) : null;
      if (linked) {
        userId = linked;
        await insertIdentity(supabase, userId, id);
      } else {
        userId = await createUser(supabase, id);
        try {
          await insertIdentity(supabase, userId, id);
        } catch (e) {
          await supabase.from("users").delete().eq("id", userId);
          throw e;
        }
      }
    }
  }
  const banned = !!(await activeBanFor(supabase, userId));
  return { userId, banned, allowlisted: allowlisted && !banned };
}

/** What /auth/complete shows for each refusal. */
export const ERROR_SENTENCES: Record<OAuthErrorCode | "network_blocked", string> = {
  not_whitelisted: "This account is not on the access list yet. Request access to join.",
  provider_error: "The sign in with the provider did not complete. Please try again.",
  state_mismatch: "This sign in link is no longer valid. Please start again.",
  already_linked: "That account is already connected to another user.",
  not_configured: "This sign in method is not configured on this server yet.",
  network_blocked: "Access from this network is blocked.",
};
