/**
 * POST /api/auth/stepup/email -> sends a 6-digit code to the user's confirmed
 * email factor, for POST /api/auth/stepup { factor: "email" }. One live code;
 * a new one replaces it. Limits live on the factor row (lib/mfa.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { enrolledFactors, sendEmailCode } from "@/lib/mfa";

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();
    const { userId } = await resolveSessionUserWithBan(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    // A pending address is confirmed through enrollment, not used for step-up.
    if (!(await enrolledFactors(supabase, userId)).includes("email")) {
      return NextResponse.json({ error: "No email factor is set up" }, { status: 404 });
    }
    const result = await sendEmailCode(supabase, userId);
    if (result === "sent") return NextResponse.json({ sent: true });
    if (result === "cooldown") return NextResponse.json({ error: "A code was just sent. Wait a minute before asking for another." }, { status: 429 });
    if (result === "daily_cap") return NextResponse.json({ error: "No more codes today. Use another factor or try tomorrow." }, { status: 429 });
    if (result === "none") return NextResponse.json({ error: "No email factor is set up" }, { status: 404 });
    return NextResponse.json({ error: "The code could not be sent" }, { status: 502 });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[stepup/email] failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "The code could not be sent" }, { status: 500 });
  }
}
