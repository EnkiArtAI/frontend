import type { SupabaseClient } from "@supabase/supabase-js";
import { isDbUnreachable, DbUnreachableError } from "@/lib/db-error";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ActiveBan = { id: string; reason: string | null; expiresAt: string | null };

/**
 * X-Session-Token → users.id + active ban, WITHOUT blocking banned users.
 * Only the banned self-service surface (/api/ban/*) may act on a banned
 * session — everything else must go through resolveSessionUserId below.
 * auth_sessions.wallet_address is either the user's UUID (fresh email-login
 * bridge) or a wallet address that maps to a user via user_wallets.
 *
 * Throws DbUnreachableError when the database host cannot be reached: a
 * dead database must never read as "not logged in" (Kev, 2026-09-05).
 */
export async function resolveSessionUserWithBan(
  supabase: SupabaseClient,
  token: string | null,
): Promise<{ userId: string | null; ban: ActiveBan | null }> {
  if (!token) return { userId: null, ban: null };
  const { data: session, error: sessionErr } = await supabase
    .from("auth_sessions")
    .select("wallet_address")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (isDbUnreachable(sessionErr)) throw new DbUnreachableError();
  if (!session) return { userId: null, ban: null };
  let userId: string | null = null;
  if (UUID.test(session.wallet_address)) {
    userId = session.wallet_address;
  } else {
    const { data: row, error: rowErr } = await supabase
      .from("user_wallets")
      .select("user_id")
      .eq("address", session.wallet_address)
      .is("removed_at", null)
      .maybeSingle();
    if (isDbUnreachable(rowErr)) throw new DbUnreachableError();
    userId = row?.user_id ?? null;
  }
  if (!userId) return { userId: null, ban: null };
  return { userId, ban: await activeBanFor(supabase, userId) };
}

/**
 * The user's active (unlifted, unexpired) full ban that lasts longest, or
 * null. Several can run at once (each sanction is its own row); the longest is
 * the one that holds, so it is the one reported.
 */
export async function activeBanFor(supabase: SupabaseClient, userId: string): Promise<ActiveBan | null> {
  const { data: bans, error: banErr } = await supabase
    .from("bans")
    .select("id, reason, expires_at")
    .eq("user_id", userId)
    .is("lifted_at", null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("expires_at", { ascending: false, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(1);
  if (isDbUnreachable(banErr)) throw new DbUnreachableError();
  const b = bans?.[0];
  return b ? { id: String(b.id), reason: (b.reason as string) ?? null, expiresAt: (b.expires_at as string) ?? null } : null;
}

/** Standard resolver: an active full ban means the session resolves to nobody. */
export async function resolveSessionUserId(supabase: SupabaseClient, token: string | null): Promise<string | null> {
  const { userId, ban } = await resolveSessionUserWithBan(supabase, token);
  return ban ? null : userId;
}

// Ownership scope for reading or changing a prompt: users.id values, never
// the raw wallet address (creator_id is a uuid column, and a non-uuid value in
// .in() is a Postgres type error, not a miss). Unlike resolveCreatorId this
// never creates rows: an update on a prompt you don't own must fail, not mint
// a user. null = no valid session, or a suspended one; [] = a session with no
// user, which owns nothing.
export async function resolveOwnerIds(
  supabase: SupabaseClient,
  token: string | null,
): Promise<string[] | null> {
  if (!token) return null;
  // The account behind the session, as everywhere else (an email login carries
  // the users.id itself), plus whoever the session's address maps to, which is
  // where a prompt saved before that was resolved may sit. A suspended
  // session owns nothing it may read or change.
  const { userId, ban } = await resolveSessionUserWithBan(supabase, token);
  if (ban) return null;
  const { data: session } = await supabase
    .from("auth_sessions")
    .select("wallet_address")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!session) return null;
  const owners = new Set<string>(userId ? [userId] : []);
  const { data: walletRow } = await supabase
    .from("user_wallets")
    .select("user_id")
    .eq("address", session.wallet_address)
    .is("removed_at", null)
    .maybeSingle();
  if (walletRow?.user_id) owners.add(String(walletRow.user_id));
  return [...owners];
}
