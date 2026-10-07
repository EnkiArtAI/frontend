import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
/**
 * POST /api/auth/password/login  { identifier, password } → { token, expiresAt, email }
 *
 * identifier is an email OR a handle (username). Verifies the Argon2id+pepper
 * credential in password_credentials and mints a session. Generic error on any
 * failure so we never reveal whether an account exists.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { verifyOrDecoy } from "@/lib/password-auth";
import { mintUserSession } from "@/lib/user-session";
import { activeBanFor } from "@/lib/session-user";
import { whitelistStageActive, isEmailAllowed, grantGateCookie } from "@/lib/allowlist";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { getClientIp, hashIp, isIpBanned } from "@/lib/ip-hash";

const bodySchema = z.object({
  identifier: z.string().min(1).max(320).optional(),
  email: z.string().max(320).optional(),
  password: z.string().min(1).max(200),
});

// Mirrors the users.handle CHECK (^[a-z0-9][a-z0-9_]{2,29}$).
const HANDLE = /^[a-z0-9][a-z0-9_]{2,29}$/;

export async function POST(req: NextRequest) {
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "auth:login:ip"), 20, 10 * 60 * 1000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  const identifier = (parsed.success ? (parsed.data.identifier ?? parsed.data.email ?? "") : "").trim().toLowerCase();
  if (!parsed.success || !identifier) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 400 });
  }

  const idLimit = checkRequestRateLimit(rateLimitKey(req, "auth:login:id", identifier), 10, 10 * 60 * 1000);
  if (!idLimit.allowed) return rateLimitResponse(idLimit.retryAfterSeconds);

  const isEmail = identifier.includes("@");
  if (!isEmail && !HANDLE.test(identifier)) {
    verifyOrDecoy(parsed.data.password, null, null); // constant-time: no enumeration via bad-shape input
    return NextResponse.json({ error: "Wrong login or password" }, { status: 401 });
  }

  const supabase = getSupabaseServerClient();
  let cred: { user_id: string; email: string; pw_hash: string; pw_salt: string } | null = null;

  if (isEmail) {
    const { data, error } = await supabase
      .from("password_credentials")
      .select("user_id, email, pw_hash, pw_salt")
      .eq("email", identifier)
      .maybeSingle();
    if (isDbUnreachable(error)) return dbUnavailableResponse();
    cred = data;
  } else {
    // handle → users.id → credential (handle is citext, case-insensitive)
    const { data: u, error: uErr } = await supabase.from("users").select("id").eq("handle", identifier).maybeSingle();
    if (isDbUnreachable(uErr)) return dbUnavailableResponse();
    if (u) {
      const { data, error } = await supabase
        .from("password_credentials")
        .select("user_id, email, pw_hash, pw_salt")
        .eq("user_id", u.id)
        .maybeSingle();
      if (isDbUnreachable(error)) return dbUnavailableResponse();
      cred = data;
    }
  }

  // Always run the KDF (decoy when absent) so response latency can't distinguish
  // "no such account" from "wrong password".
  const ok = verifyOrDecoy(parsed.data.password, cred?.pw_hash, cred?.pw_salt);
  if (!ok || !cred) {
    return NextResponse.json({ error: "Wrong login or password" }, { status: 401 });
  }

  // Private-beta whitelist: the account exists, but app access still needs the
  // email to be allow-listed. Generic 401 keeps it from being an oracle.
  let emailAllowed = true;
  try {
    emailAllowed = !whitelistStageActive() || (await isEmailAllowed(supabase, cred.email));
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
  if (!emailAllowed) {
    return NextResponse.json({ error: "Wrong login or password" }, { status: 401 });
  }

  const ipHash = hashIp(getClientIp(req));
  if (await isIpBanned(supabase, ipHash)) {
    return NextResponse.json({ error: "Access from this network is blocked." }, { status: 403 });
  }
  // Banned users still get a session — it only opens /api/ban/* (status,
  // appeal, funds). The banned flag routes the client to /banned.
  const banned = !!(await activeBanFor(supabase, cred.user_id));
  const session = await mintUserSession(cred.user_id, ipHash);
  // Whitelisted login → grant app access (gate cookie).
  return grantGateCookie(NextResponse.json({ email: cred.email, ...session, ...(banned ? { banned: true } : {}) }));
}
