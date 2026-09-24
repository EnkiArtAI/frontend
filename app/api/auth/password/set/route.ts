/**
 * POST /api/auth/password/set (session)  { password } → { email }
 *
 * Gives a Google or X account a password login. Only for accounts without
 * one (changing a password stays with the reset flow). The email is the one a
 * connected provider VERIFIED; nothing typed into a body is accepted, because
 * password_credentials.email is the login identifier and an unconfirmed
 * address there would block its real owner from registering. An X account
 * without a confirmed email connects Google first.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { hashPassword } from "@/lib/password-auth";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";

const bodySchema = z.object({ password: z.string().min(8).max(200) });

export async function POST(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "auth:password-set:ip"), 10, 10 * 60 * 1000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });

  const supabase = getSupabaseServerClient();
  try {
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const { data: existing, error: existingErr } = await supabase
      .from("password_credentials")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existing) return NextResponse.json({ error: "This account already has a password. Use reset to change it." }, { status: 409 });

    const { data: ids, error: idsErr } = await supabase
      .from("auth_identities")
      .select("email")
      .eq("user_id", userId)
      .eq("email_verified", true)
      .not("email", "is", null)
      .limit(1);
    if (idsErr) throw idsErr;
    const email = ((ids?.[0]?.email as string | undefined) ?? "").trim().toLowerCase();
    if (!email) return NextResponse.json({ error: "Connect an account with a verified email first." }, { status: 400 });

    const { data: taken, error: takenErr } = await supabase
      .from("password_credentials")
      .select("user_id")
      .eq("email", email)
      .maybeSingle();
    if (takenErr) throw takenErr;
    if (taken) return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 });

    const { hash, salt } = hashPassword(parsed.data.password);
    const { error: credErr } = await supabase
      .from("password_credentials")
      .insert({ user_id: userId, email, pw_hash: hash, pw_salt: salt });
    if (credErr) {
      if (credErr.code === "23505") return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 });
      throw credErr;
    }
    return NextResponse.json({ email });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}
