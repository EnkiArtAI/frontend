/**
 * POST /api/auth/password/set (session)  { password, email? } → { email }
 *
 * Gives a Google or X account a password login. Only for accounts without
 * one (changing a password stays with the reset flow). The email comes from
 * the provider identity, or from the body when the provider gave none, and
 * is stored exactly as register stores it.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { hashPassword } from "@/lib/password-auth";
import { emailColumns } from "@/lib/auth/oauth";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";

const bodySchema = z.object({
  password: z.string().min(8).max(200),
  email: z.string().email().max(320).optional(),
});

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

    // The provider's email wins: it is the one the account is known by.
    const { data: ids } = await supabase
      .from("auth_identities")
      .select("email, email_verified")
      .eq("user_id", userId)
      .not("email", "is", null)
      .order("email_verified", { ascending: false })
      .limit(1);
    const fromIdentity = ids?.[0];
    const email = ((fromIdentity?.email as string | undefined) ?? parsed.data.email ?? "").trim().toLowerCase();
    if (!email) return NextResponse.json({ error: "An email is needed to sign in with a password. Add one." }, { status: 400 });

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
    // An email the provider never gave lands on the users row too (lookup
    // hash, ciphertext when the keyring is configured), unverified.
    if (!fromIdentity) await supabase.from("users").update(emailColumns(email, false)).eq("id", userId);

    return NextResponse.json({ email });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}
