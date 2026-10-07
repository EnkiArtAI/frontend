import { NextRequest, NextResponse } from "next/server";
import { createHmac, hkdfSync, timingSafeEqual } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { enrolledFactors, type Factor } from "@/lib/mfa";

/**
 * App-side WebAuthn passkeys for STEP-UP 2FA. Opt-in: a user who registers a
 * passkey must re-verify with it before sensitive actions (delete work,
 * withdrawals). Gates OUR endpoints via OUR session — independent of the wallet
 * vendor. See migrations/2026-07-11-webauthn.sql and app/api/auth/passkey/*.
 */
export const RP_NAME = "Enki Art";
const CHALLENGE_TTL_S = 300;
const STEPUP_TTL_S = 300;

// SECURITY: the expected origin/RP MUST NOT come from the request (the Origin
// header is attacker-controllable on a plain JSON POST), or WebAuthn's
// anti-phishing binding becomes tautological. Pin it to server config:
// WEBAUTHN_ORIGIN (+ optional WEBAUTHN_RP_ID), defaulting to localhost:3008 for
// dev. Prod MUST set WEBAUTHN_ORIGIN to the real origin.
export function rp(): { rpID: string; origin: string } {
  const origin = (process.env.WEBAUTHN_ORIGIN || "http://localhost:3008").replace(/\/$/, "");
  const rpID = process.env.WEBAUTHN_RP_ID || new URL(origin).hostname;
  return { rpID, origin };
}

// Passkeys key on the STABLE users.id, not the volatile session wallet_address
// (which is users.id before a wallet is attached and the address after).
export async function resolveStableUserId(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  walletAddress: string,
): Promise<string | null> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(walletAddress)) {
    return walletAddress;
  }
  const { data } = await supabase
    .from("user_wallets")
    .select("user_id")
    .ilike("address", walletAddress)
    .is("removed_at", null)
    .maybeSingle();
  return data?.user_id ?? null;
}

// Step-up proof is a short-lived signed token, NOT server state: stepup/verify
// mints it, the sensitive endpoint verifies it (bound to user + scope). The
// signing key is HKDF-derived from AUTH_PEPPER so it needs no extra env and is
// domain-separated from the password pepper.
function stepUpKey(): Uint8Array {
  const p = process.env.AUTH_PEPPER;
  if (!p) throw new Error("AUTH_PEPPER not configured");
  return new Uint8Array(hkdfSync("sha256", Buffer.from(p, "base64"), new Uint8Array(0), Buffer.from("enki-stepup-v1"), 32));
}

/* What a step-up can be for. A scope names one action, and where the action
   has a target, that target: one tap deletes one image, never another. */
const SCOPE = /^(add-factor|guardians|delete-work:[0-9a-f-]{36}|remove-factor:([0-9a-f-]{36}|totp|email))$/i;
export function isStepUpScope(scope: unknown): scope is string {
  return typeof scope === "string" && SCOPE.test(scope);
}

export async function mintStepUpToken(userId: string, scope: string): Promise<string> {
  if (!isStepUpScope(scope)) throw new Error(`unknown step-up scope: ${scope}`);
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${STEPUP_TTL_S}s`)
    .sign(stepUpKey());
}

async function verifyStepUpToken(token: string, userId: string, scope: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, stepUpKey());
    return payload.sub === userId && payload.scope === scope;
  } catch {
    return false;
  }
}

// How old a session may be to set up a user's FIRST factor. A factor someone
// else plants locks the owner out of every gated action and lets the planter
// through them, so it takes a fresh login, not just any live session.
const FIRST_FACTOR_SESSION_MS = 10 * 60_000;

/**
 * Gate for adding a factor (passkey, authenticator, email) or a guardian,
 * who can reset the password. With a factor already in place it is a step-up
 * like any other; without one it needs a session younger than ten minutes,
 * answering 403 { reauth } otherwise.
 */
export async function requireAddFactor(req: NextRequest, userId: string, scope = "add-factor"): Promise<NextResponse | null> {
  const supabase = getSupabaseServerClient();
  let factors: Factor[];
  try {
    factors = await enrolledFactors(supabase, userId);
  } catch {
    return NextResponse.json({ error: "Could not verify security settings" }, { status: 503 });
  }
  if (factors.length > 0) return requireStepUp(req, userId, scope, { mandatory: true });
  const { data, error } = await supabase
    .from("auth_sessions")
    .select("created_at")
    .eq("token", req.headers.get("X-Session-Token") ?? "")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Could not verify security settings" }, { status: 503 });
  if (!data || Date.now() - Date.parse(String(data.created_at)) > FIRST_FACTOR_SESSION_MS) {
    return NextResponse.json({ error: "Sign in again to change your security settings", reauth: true }, { status: 403 });
  }
  return null;
}

/**
 * Gate a sensitive action behind step-up 2FA. A user with any factor
 * (passkey, authenticator, email code) needs a valid X-StepUp-Token for this
 * scope, minted by whichever factor they used; the answer names their
 * factors so the client can offer them. Without a factor the action proceeds,
 * unless `mandatory`, which answers 403 { enroll } instead. Fails CLOSED: no
 * user is 401, a failed factor lookup 503.
 * Returns null when allowed, or the NextResponse to return when blocked.
 */
export async function requireStepUp(
  req: NextRequest,
  userId: string | null,
  scope: string,
  { mandatory = false }: { mandatory?: boolean } = {},
): Promise<NextResponse | null> {
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  let factors: Factor[];
  try {
    factors = await enrolledFactors(getSupabaseServerClient(), userId);
  } catch {
    return NextResponse.json({ error: "Could not verify security settings" }, { status: 503 });
  }
  if (factors.length === 0) {
    return mandatory ? NextResponse.json({ error: "Set up a second factor first", scope, enroll: true }, { status: 403 }) : null;
  }
  const token = req.headers.get("X-StepUp-Token");
  if (token && (await verifyStepUpToken(token, userId, scope))) return null;
  return NextResponse.json({ error: "Step-up verification required", scope, stepUp: true, factors }, { status: 401 });
}

// ── challenge cookie (httpOnly; no DB row needed) ───────────────────────────
// Signed for one user, one purpose and five minutes. Unsigned, the server took
// whatever challenge the client sent: a script with a stolen session could
// verify a self-made attestation, and a captured assertion could be replayed
// with its own challenge for any scope.
const COOKIE_PATH = "/api/auth/passkey";

function challengeMac(name: string, userId: string, challenge: string, expiry: string): Buffer {
  const p = process.env.AUTH_PEPPER;
  if (!p) throw new Error("AUTH_PEPPER not configured");
  const key = hkdfSync("sha256", Buffer.from(p, "base64"), new Uint8Array(0), Buffer.from("enki-webauthn-challenge-v1"), 32);
  return createHmac("sha256", Buffer.from(key)).update(`${name}|${userId}|${challenge}|${expiry}`).digest();
}

export function setChallengeCookie(res: NextResponse, name: string, challenge: string, userId: string) {
  const expiry = String(Date.now() + CHALLENGE_TTL_S * 1000);
  const mac = challengeMac(name, userId, challenge, expiry).toString("base64url");
  res.cookies.set(name, `${challenge}.${expiry}.${mac}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: COOKIE_PATH,
    maxAge: CHALLENGE_TTL_S,
  });
}

/** The challenge this server issued to this user for this purpose, still fresh; otherwise undefined. */
export function readChallengeCookie(req: NextRequest, name: string, userId: string): string | undefined {
  const [challenge, expiry, mac] = (req.cookies.get(name)?.value ?? "").split(".");
  if (!challenge || !expiry || !mac || Number(expiry) < Date.now()) return undefined;
  const expected = challengeMac(name, userId, challenge, expiry);
  const given = Buffer.from(mac, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected) ? challenge : undefined;
}

export function clearChallengeCookie(res: NextResponse, name: string): NextResponse {
  res.cookies.set(name, "", { path: COOKIE_PATH, maxAge: 0 });
  return res;
}
