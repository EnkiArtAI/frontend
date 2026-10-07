/**
 * POST /api/auth/password/reset-code  { email, code, password } → session
 *
 * Redeems the emailed 7-digit code: sets the new password, evicts all old
 * sessions, logs the user in. Brute force is boxed in by the per-email rate
 * limit (5 tries / 15 min — a 7-digit code has 9M combinations) plus the
 * 15-minute code TTL and one-live-code-per-user.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { completePasswordReset, sha256 } from "@/lib/password-reset";
import { loginRefusal } from "@/lib/password-login";
import { activeBanFor } from "@/lib/session-user";
import { grantGateCookie } from "@/lib/allowlist";

const bodySchema = z.object({
  email: z.string().email().max(320),
  code: z.string().regex(/^\d{7}$/),
  password: z.string().min(8).max(200),
});

export async function POST(req: NextRequest) {
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "auth:resetcode:ip"), 20, 15 * 60 * 1000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const email = parsed.data.email.trim().toLowerCase();

  // The binding brute-force guard: 5 attempts per email per window.
  const emailLimit = checkRequestRateLimit(rateLimitKey(req, "auth:resetcode", email), 5, 15 * 60 * 1000);
  if (!emailLimit.allowed) return rateLimitResponse(emailLimit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const { data: cred } = await supabase
    .from("password_credentials")
    .select("user_id")
    .eq("email", email)
    .maybeSingle();
  if (!cred) return NextResponse.json({ error: "Wrong or expired code" }, { status: 400 });

  const { data: row } = await supabase
    .from("password_reset_tokens")
    .select("token, user_id, expires_at")
    .eq("user_id", cred.user_id)
    .eq("token", sha256(parsed.data.code))
    .maybeSingle();
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
    return NextResponse.json({ error: "Wrong or expired code" }, { status: 400 });
  }

  // It ends in a login: the same access list and network checks first, and
  // the ban read now, so nothing that can fail runs after the password is set.
  const gate = await loginRefusal(req, supabase, email);
  if (gate.refusal) return gate.refusal;
  const banned = !!(await activeBanFor(supabase, row.user_id));

  // One-shot: burn the code before setting the password.
  await supabase.from("password_reset_tokens").delete().eq("user_id", cred.user_id);

  // The code came through the inbox: the email is confirmed (Kev, 2026-10-07).
  const result = await completePasswordReset(supabase, row.user_id, parsed.data.password, { inboxProven: true, ipHash: gate.ipHash });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 500 });
  // Enters like a login: the gate cookie, and /banned for a banned account.
  return grantGateCookie(NextResponse.json({ ...result, ...(banned ? { banned: true } : {}) }));
}
