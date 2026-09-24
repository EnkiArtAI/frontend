/**
 * DELETE /api/auth/identities/[provider] (session) → { removed }
 *
 * Disconnects a Google or X account. Refused when it is the last way to sign
 * in: the user would be locked out of their own account.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { loginMethods } from "@/lib/auth/login-methods";
import { isProvider } from "@/lib/auth/oauth";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  if (!isProvider(provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const supabase = getSupabaseServerClient();
  try {
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const { identities, loginMethodCount } = await loginMethods(supabase, userId);
    if (!identities.some((i) => i.provider === provider)) {
      return NextResponse.json({ error: "That account is not connected" }, { status: 404 });
    }
    if (loginMethodCount <= 1) {
      return NextResponse.json(
        { error: "This is the only way to sign in to this account. Set a password or connect another account first." },
        { status: 409 },
      );
    }
    const { error } = await supabase.from("auth_identities").delete().eq("user_id", userId).eq("provider", provider);
    if (error) throw error;
    return NextResponse.json({ removed: provider });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}
