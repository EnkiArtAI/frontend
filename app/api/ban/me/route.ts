/**
 * GET /api/ban/me — the banned self-service surface (works WITH an active
 * ban; everything else in the API refuses banned sessions). Returns the ban,
 * the latest appeal for it, and the user's wallets so the /banned page can
 * show that funds remain theirs.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { grantGateCookie, revokeGateCookie } from "@/lib/allowlist";

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const token = req.headers.get("X-Session-Token");
  const { userId, ban } = await resolveSessionUserWithBan(supabase, token);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  // A ban that ended gives app access back: the login that minted this
  // session passed the allowlist but got no cookie while banned.
  if (!ban) return grantGateCookie(NextResponse.json({ banned: false }));

  const [{ data: appeals }, { data: wallets }, { data: session }] = await Promise.all([
    supabase.from("appeals")
      .select("status, created_at, decision_notes")
      .eq("user_id", userId).eq("target_uuid", ban.id)
      .order("created_at", { ascending: false }).limit(1),
    supabase.from("user_wallets")
      .select("address, chain_family")
      .eq("user_id", userId).is("removed_at", null),
    supabase.from("auth_sessions").select("wallet_type").eq("token", token).maybeSingle(),
  ]);
  const a = appeals?.[0] ?? null;
  // user_wallets cannot tell an embedded wallet from a self-custodial one:
  // attach-wallet writes the CDP wallet as external_eoa too, and the
  // wallet_type CHECK has no value for it (probed 2026-10-07: only
  // external_eoa and smart_account pass). How the account signs in can: a
  // password session (social login reuses the type) gets wallets only
  // through attach-wallet, a wallet login brings its own.
  const embedded = session?.wallet_type === "password";
  return revokeGateCookie(NextResponse.json({
    banned: true,
    reason: ban.reason,
    permanent: !ban.expiresAt,
    expiresAt: ban.expiresAt,
    appeal: a ? { status: String(a.status), at: a.created_at, notes: (a.decision_notes as string) ?? null } : null,
    wallets: (wallets ?? []).map((w) => ({
      address: String(w.address),
      external: !embedded,
      chain: String(w.chain_family),
    })),
  }));
}
