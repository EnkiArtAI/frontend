import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
/**
 * POST /api/auth/password/login  { identifier, password } → { token, expiresAt, email }
 *
 * identifier is an email OR a handle (username). Verifies the Argon2id+pepper
 * credential in password_credentials and mints a session. Generic error on any
 * failure so we never reveal whether an account exists.
 *
 * An invited account still on its mailed one-time password gets no session:
 * the answer is { setPassword: true }, and only POST
 * /api/auth/password/first-login turns it into a login (Kev, 2026-10-07).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { verifyOrDecoy } from "@/lib/password-auth";
import { loginRefusal, openLoginSession } from "@/lib/password-login";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";

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
  let cred: { user_id: string; email: string; pw_hash: string; pw_salt: string; must_change_password: boolean } | null = null;
  // A credential that cannot be read is no "wrong password": the honest 503.
  const COLS = "user_id, email, pw_hash, pw_salt, must_change_password";

  if (isEmail) {
    const { data, error } = await supabase.from("password_credentials").select(COLS).eq("email", identifier).maybeSingle();
    if (error) return dbUnavailableResponse();
    cred = data;
  } else {
    // handle → users.id → credential (handle is citext, case-insensitive)
    const { data: u, error: uErr } = await supabase.from("users").select("id").eq("handle", identifier).maybeSingle();
    if (isDbUnreachable(uErr)) return dbUnavailableResponse();
    if (u) {
      const { data, error } = await supabase.from("password_credentials").select(COLS).eq("user_id", u.id).maybeSingle();
      if (error) return dbUnavailableResponse();
      cred = data;
    }
  }

  // Always run the KDF (decoy when absent) so response latency can't distinguish
  // "no such account" from "wrong password".
  const ok = verifyOrDecoy(parsed.data.password, cred?.pw_hash, cred?.pw_salt);
  if (!ok || !cred) {
    return NextResponse.json({ error: "Wrong login or password" }, { status: 401 });
  }

  // Private-beta whitelist and IP bans, as for every password login.
  const gate = await loginRefusal(req, supabase, cred.email);
  if (gate.refusal) return gate.refusal;
  // The one-time password opens only the step that replaces it.
  if (cred.must_change_password) return NextResponse.json({ setPassword: true });
  return openLoginSession(supabase, cred.user_id, cred.email, gate.ipHash);
}
