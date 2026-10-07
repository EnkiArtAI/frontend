/**
 * POST /api/auth/password/verify-email { code } -> { verified }
 * POST /api/auth/password/verify-email {}       -> { sent }, a new code
 *
 * Confirms a password account's login email with the code register mailed.
 * The confirmed address becomes the account's email step-up factor, and only
 * a confirmed login email is told to the wallet vendor as verified. A code
 * mailed to another address (settings can start one) confirms that factor
 * elsewhere, never the login email.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { beginEmail, checkCode, emailFactorAddress } from "@/lib/mfa";

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const { data: cred, error } = await supabase
      .from("password_credentials")
      .select("email, email_verified_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    if (!cred) return NextResponse.json({ error: "No password account" }, { status: 404 });
    if (cred.email_verified_at) return NextResponse.json({ verified: true });

    const body = (await req.json().catch(() => ({}))) as { code?: unknown };
    if (typeof body.code !== "string") {
      const sent = await beginEmail(supabase, userId, cred.email);
      if (sent === "sent") return NextResponse.json({ sent: true });
      if (sent === "exists") return NextResponse.json({ error: "An email factor is already set up" }, { status: 409 });
      if (sent === "cooldown" || sent === "daily_cap") return NextResponse.json({ error: "Too many codes. Wait before asking for another." }, { status: 429 });
      return NextResponse.json({ error: "The code could not be sent" }, { status: 502 });
    }

    if ((await emailFactorAddress(supabase, userId)) !== cred.email) {
      return NextResponse.json({ error: "Ask for a new code: the last one went to another address" }, { status: 409 });
    }
    const result = await checkCode(supabase, userId, "email", body.code, { confirm: true });
    if (result === "none") return NextResponse.json({ error: "This code expired. Ask for a new one." }, { status: 404 });
    if (result === "locked") return NextResponse.json({ error: "Too many wrong codes. Try again later." }, { status: 429 });
    if (result === "busy") return NextResponse.json({ error: "Another check is running, try again" }, { status: 409 });
    if (result !== "ok") return NextResponse.json({ error: "Wrong code" }, { status: 400 });

    const { error: stampErr } = await supabase
      .from("password_credentials")
      .update({ email_verified_at: new Date().toISOString() })
      .eq("user_id", userId);
    if (stampErr) throw stampErr;
    return NextResponse.json({ verified: true });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[auth/verify-email] failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not verify the email" }, { status: 500 });
  }
}
