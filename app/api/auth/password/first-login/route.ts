/**
 * POST /api/auth/password/first-login  { email, password, newPassword } → { email, token, expiresAt }
 *
 * An invited account's first login (Kev, 2026-10-07). The admin's approval
 * mailed a one-time password; the login answers it with { setPassword } and
 * nothing else. Here it is checked again and replaced by the user's own, the
 * email counts as confirmed (the password came through the inbox), and the
 * session opens like any login. From then on only the new password works.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { dbUnavailableResponse } from "@/lib/db-error";
import { hashPassword, verifyOrDecoy } from "@/lib/password-auth";
import { loginRefusal, openLoginSession } from "@/lib/password-login";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";

const bodySchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

export async function POST(req: NextRequest) {
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "auth:firstlogin:ip"), 20, 10 * 60 * 1000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose a password of at least 8 characters." }, { status: 400 });
  const email = parsed.data.email.trim().toLowerCase();

  const idLimit = checkRequestRateLimit(rateLimitKey(req, "auth:firstlogin:id", email), 10, 10 * 60 * 1000);
  if (!idLimit.allowed) return rateLimitResponse(idLimit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const { data: cred, error } = await supabase
    .from("password_credentials")
    .select("user_id, email, pw_hash, pw_salt")
    .eq("email", email)
    .maybeSingle();
  if (error) return dbUnavailableResponse();

  // Always run the KDF (decoy when absent), as the login does.
  if (!verifyOrDecoy(parsed.data.password, cred?.pw_hash, cred?.pw_salt) || !cred) {
    return NextResponse.json({ error: "Wrong login or password" }, { status: 401 });
  }
  if (parsed.data.newPassword === parsed.data.password) {
    return NextResponse.json({ error: "Choose your own password, not the one from the email." }, { status: 400 });
  }

  const gate = await loginRefusal(req, supabase, cred.email);
  if (gate.refusal) return gate.refusal;

  // Only a one-time password is ever replaced here, never one the user chose;
  // of two racing submits, one wins and the other changes nothing.
  const { hash, salt } = hashPassword(parsed.data.newPassword);
  const now = new Date().toISOString();
  const { data: changed, error: updErr } = await supabase
    .from("password_credentials")
    .update({ pw_hash: hash, pw_salt: salt, must_change_password: false, email_verified_at: now, updated_at: now })
    .eq("user_id", cred.user_id)
    .eq("must_change_password", true)
    .select("user_id");
  if (updErr) return dbUnavailableResponse();
  if (!changed?.length) {
    return NextResponse.json({ error: "This account has its own password already. Log in with it." }, { status: 409 });
  }

  return openLoginSession(supabase, cred.user_id, cred.email, gate.ipHash);
}
