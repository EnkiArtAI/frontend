import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
/**
 * POST /api/auth/password/register  { email, password } → { token, expiresAt, email }
 *
 * Creates a bare users row + an Argon2id+pepper credential in
 * password_credentials (isolated from the encrypted-email design),
 * then mints a session: straight in, no code (Kev, 2026-10-07). 2FA is
 * optional and never the email, which resets the password; a red bar asks
 * for it. The wallet is a non-custodial embedded wallet attached after
 * login — Enki never holds keys.
 *
 * Closed during the private beta (Kev, 2026-10-07: "wired but not activated"):
 * it answers 403 { closed } unless SIGNUP_OPEN=1 is set, so hiding the form on
 * the landing (its own SIGNUP_OPEN) is not the only lock. Open both together.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { hashPassword } from "@/lib/password-auth";
import { mintUserSession } from "@/lib/user-session";
import { getClientIp, hashIp, isIpBanned } from "@/lib/ip-hash";
import { whitelistStageActive, isEmailAllowed, admitAllowlisted, grantGateCookie } from "@/lib/allowlist";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";

const bodySchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
});

export async function POST(req: NextRequest) {
  if (process.env.SIGNUP_OPEN !== "1") {
    return NextResponse.json({ error: "Sign-up opens after the private beta. Request access to join.", closed: true }, { status: 403 });
  }
  const limit = checkRequestRateLimit(rateLimitKey(req, "auth:register:ip"), 10, 10 * 60 * 1000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid email or password" }, { status: 400 });
  const email = parsed.data.email.trim().toLowerCase();

  const supabase = getSupabaseServerClient();

  // Council-banned network → no fresh accounts (the ban-evasion path).
  const ipHash = hashIp(getClientIp(req));
  if (await isIpBanned(supabase, ipHash)) {
    return NextResponse.json({ error: "Access from this network is blocked." }, { status: 403 });
  }

  // Private-beta whitelist: only allow-listed emails may register.
  let emailAllowed = true;
  try {
    emailAllowed = !whitelistStageActive() || (await isEmailAllowed(supabase, email));
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
  if (!emailAllowed) {
    return NextResponse.json(
      { error: "This email isn't on the access list yet. Request access to join.", notWhitelisted: true },
      { status: 403 },
    );
  }

  const { data: existing, error: existingErr } = await supabase
    .from("password_credentials")
    .select("user_id")
    .eq("email", email)
    .maybeSingle();
  if (isDbUnreachable(existingErr)) return dbUnavailableResponse();
  if (existing) return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 });

  const { hash, salt } = hashPassword(parsed.data.password);

  // One bare users row per password account (handle/profile filled in later),
  // so user_wallets + prompts.creator_id link like any other identity.
  const { data: user, error: userErr } = await supabase
    .from("users")
    .insert({ account_status: "active" })
    .select("id")
    .single();
  if (userErr || !user) {
    if (isDbUnreachable(userErr)) return dbUnavailableResponse();
    console.error("[auth/register] users insert failed:", userErr?.message);
    return NextResponse.json({ error: "Could not create account" }, { status: 500 });
  }

  const { error: credErr } = await supabase
    .from("password_credentials")
    .insert({ user_id: user.id, email, pw_hash: hash, pw_salt: salt });
  if (credErr) {
    // Roll back the orphan users row; a race on the unique email index lands here.
    await supabase.from("users").delete().eq("id", user.id);
    const conflict = credErr.code === "23505";
    return NextResponse.json(
      { error: conflict ? "An account with this email already exists" : "Could not create account" },
      { status: conflict ? 409 : 500 },
    );
  }

  // The email passed the access list above: the new account is a beta member.
  await admitAllowlisted(supabase, user.id);
  const session = await mintUserSession(user.id, ipHash);
  // Whitelisted registration → grant app access (gate cookie).
  return grantGateCookie(NextResponse.json({ email, ...session }));
}
