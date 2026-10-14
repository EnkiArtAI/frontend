import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClientSafe } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { freeQuotaFor } from "@/lib/generation/free-quota";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";

/** Read-only allowance display; account identity comes only from the session. */
export async function GET(request: NextRequest) {
  const token = request.headers.get("X-Session-Token");
  if (!token) return NextResponse.json({ error: "Sign in to check your free allowance." }, { status: 401 });
  const supabase = getSupabaseServerClientSafe();
  if (!supabase) return dbUnavailableResponse();
  try {
    const userId = await resolveSessionUserId(supabase, token);
    if (!userId) return NextResponse.json({ error: "Sign in to check your free allowance." }, { status: 401 });
    const freeQuota = await freeQuotaFor(supabase, userId);
    return NextResponse.json({ freeQuota }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (isDbUnreachable(error)) return dbUnavailableResponse();
    return NextResponse.json({ error: "Your free allowance could not be checked. Please try again." }, { status: 503 });
  }
}
