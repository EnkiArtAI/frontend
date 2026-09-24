/**
 * GET /api/auth/identities (session) → { identities, hasPassword, hasWallet }
 *
 * The connected accounts panel in profile settings.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { loginMethods } from "@/lib/auth/login-methods";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  try {
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const { identities, hasPassword, hasWallet } = await loginMethods(supabase, userId);
    return NextResponse.json({
      identities: identities.map((i) => ({
        provider: i.provider,
        handle: i.handle,
        email: i.email,
        displayName: i.display_name,
        avatarUrl: i.avatar_url,
        connectedAt: i.created_at,
      })),
      hasPassword,
      hasWallet,
    });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}
