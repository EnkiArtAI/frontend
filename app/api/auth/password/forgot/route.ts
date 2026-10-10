/**
 * POST /api/auth/password/forgot  { email } → { ok: true } (always)
 *
 * Emails a single-use 7-digit reset code (15 min TTL). Only the SHA-256 of the
 * code is stored (in password_reset_tokens.token), so a DB leak reveals no
 * usable codes. Always returns ok so an attacker can't probe which emails
 * exist. Without RESEND_API_KEY the code is logged server-side in dev.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { numericCode, sha256 } from "@/lib/password-reset";
import { sendMail } from "@/lib/mailer";
import { createErrorResponse } from "@/middleware/validation";

const RESET_TTL_MS = 15 * 60 * 1000;
const bodySchema = z.object({ email: z.string().email().max(320) });

export async function POST(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "auth:forgot:ip"), 10, 10 * 60 * 1000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  // Checked before the email lookup, so this fires identically for every
  // request regardless of whether the email exists — it answers "is the
  // feature configured", never "does this email have an account" (the
  // dev-mode console-log fallback below is an intentional exception, not a
  // silent production failure).
  if (process.env.NODE_ENV === "production" && !process.env.RESEND_API_KEY?.trim()) {
    return createErrorResponse("Password reset email is not configured on this environment", 503);
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: true });
  const email = parsed.data.email.trim().toLowerCase();

  const supabase = getSupabaseServerClient();
  const { data: cred } = await supabase
    .from("password_credentials")
    .select("user_id")
    .eq("email", email)
    .maybeSingle();
  if (cred) {
    // One live code per user: replace older ones so guessing windows don't stack.
    await supabase.from("password_reset_tokens").delete().eq("user_id", cred.user_id);
    const code = numericCode(7);
    const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
    await supabase
      .from("password_reset_tokens")
      .insert({ token: sha256(code), user_id: cred.user_id, expires_at: expiresAt });

    const mail = await sendMail({
      to: email,
      subject: `${code} is your Enki Art reset code`,
      text:
        `Your Enki Art password reset code is:\n\n    ${code}\n\n` +
        `Enter it on the reset page within 15 minutes. If you didn't ask for this, you can ignore this email — nothing changes without the code.`,
    });
    if (!mail.ok && process.env.NODE_ENV !== "production") {
      console.log(`[auth/forgot] email not configured — reset code for ${email}: ${code}`);
    }
  }

  return NextResponse.json({ ok: true });
}
