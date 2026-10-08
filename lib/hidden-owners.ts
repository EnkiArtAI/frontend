import type { SupabaseClient } from "@supabase/supabase-js";
import { DbUnreachableError, isDbUnreachable } from "@/lib/db-error";

/**
 * Of these users, the ones whose content leaves the public surfaces and whose
 * prompts are not sold: an account deleted or not active, or one with an
 * active ban (the rule activeBanFor uses). "A ban locks the marketplace,
 * never the wallet": the ban already stops the session; this stops the
 * account's prompts, images and profile from staying public and paying out.
 * null when the lookup failed: callers refuse rather than guess. A database
 * that cannot be reached throws DbUnreachableError, so callers answer the
 * outage as one (503), never as a refusal of their own.
 */
export async function hiddenOwners(supabase: SupabaseClient, userIds: string[]): Promise<Set<string> | null> {
  const ids = [...new Set(userIds.filter((id) => typeof id === "string" && id !== ""))];
  if (ids.length === 0) return new Set();
  const [accounts, bans] = await Promise.all([
    supabase.from("users").select("id, deleted_at, account_status").in("id", ids),
    supabase
      .from("bans")
      .select("user_id")
      .in("user_id", ids)
      .is("lifted_at", null)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`),
  ]);
  if (isDbUnreachable(accounts.error) || isDbUnreachable(bans.error)) throw new DbUnreachableError();
  if (accounts.error || bans.error) return null;
  const hidden = new Set<string>();
  for (const a of accounts.data ?? []) {
    if (a.deleted_at || (a.account_status != null && a.account_status !== "active")) hidden.add(String(a.id));
  }
  for (const b of bans.data ?? []) hidden.add(String(b.user_id));
  return hidden;
}
