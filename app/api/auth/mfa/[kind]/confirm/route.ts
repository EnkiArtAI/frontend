/**
 * POST /api/auth/mfa/[kind]/confirm { code } -> { confirmed }
 *
 * The first right code from the authenticator app, or from the inbox, proves
 * the user holds it; from then on the factor counts for step-up. The same
 * attempt counter and lock as a step-up apply (lib/mfa.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { checkCode } from "@/lib/mfa";

export async function POST(req: NextRequest, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  if (kind !== "totp" && kind !== "email") return NextResponse.json({ error: "Unknown factor" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { code?: unknown };
  if (typeof body.code !== "string") return NextResponse.json({ error: "code required" }, { status: 400 });
  try {
    const supabase = getSupabaseServerClient();
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const result = await checkCode(supabase, userId, kind, body.code, { confirm: true });
    if (result === "ok") return NextResponse.json({ confirmed: true });
    if (result === "none") return NextResponse.json({ error: "Start the setup first" }, { status: 404 });
    if (result === "locked") return NextResponse.json({ error: "Too many wrong codes. Try again later." }, { status: 429 });
    if (result === "busy") return NextResponse.json({ error: "Another check is running, try again" }, { status: 409 });
    return NextResponse.json({ error: "Wrong code" }, { status: 400 });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[mfa] confirm failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not confirm the factor" }, { status: 500 });
  }
}
