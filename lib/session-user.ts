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

/** The user's newest active (unlifted, unexpired) full ban, or null. */
export async function activeBanFor(supabase: SupabaseClient, userId: string): Promise<ActiveBan | null> {
  const { data: bans, error: banErr } = await supabase
    .from("bans")
    .select("id, reason, expires_at")
    .eq("user_id", userId)
    .is("lifted_at", null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
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

/**
 * Session token → users.id, creating the user on first contact. Moved here
 * from /api/prompt (resolveCreatorId), where it has resolved the prompt's
 * creator from the session, NEVER from the client (a client-supplied userId
 * could claim any creator, and the payment quote pays the artist share to that
 * creator's wallet). An unknown wallet address gets a bare users row plus its
 * user_wallets mapping, the same idiom as /api/auth/session.
 */
export async function resolveOrCreateSessionUserId(
  supabase: SupabaseClient,
  token: string | null,
): Promise<string | null> {
  if (!token) return null;

  const { data: session } = await supabase
    .from("auth_sessions")
    .select("wallet_address, wallet_type")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!session) return null;
  // A fresh password or provider login (no wallet attached yet) carries
  // users.id itself; minting a second users row for it would split the account.
  if (UUID.test(session.wallet_address)) return session.wallet_address;

  const { data: walletRow } = await supabase
    .from("user_wallets")
    .select("user_id")
    .eq("address", session.wallet_address)
    .is("removed_at", null)
    .maybeSingle();
  if (walletRow?.user_id) return walletRow.user_id;

  const { data: created, error: createError } = await supabase
    .from("users")
    .insert({})
    .select("id")
    .single();
  if (createError || !created?.id) {
    console.error("[session-user] creator user insert failed:", createError?.message);
    return null;
  }
  await supabase.from("user_wallets").insert({
    user_id: created.id,
    address: session.wallet_address,
    chain_family: session.wallet_type === "evm" ? "evm" : "solana",
    wallet_type: "external_eoa",
    is_primary: true,
  });
  return created.id;
}
