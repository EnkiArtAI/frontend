/**
 * One rule for every ban that lands on a running one. A ban that ends later
 * is issued as its own row, never merged into the running one: each keeps its
 * reason and its appeal, and lifting one (an approved appeal) leaves the
 * other in force. A ban that ends no later than the running one adds nothing.
 * activeBanFor reports the ban that lasts longest, so a shorter row never
 * hides a longer one. Skipping the later ban instead let a permanent
 * child-safety ban vanish behind a 3-day suspension.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { activeBanFor } from "@/lib/session-user";

/** The later of two ends, null being for good. Compared as instants, not as strings. */
export function laterEnd(running: string | null, next: string | null): string | null {
  if (running === null || next === null) return null;
  return Date.parse(running) >= Date.parse(next) ? running : next;
}

/**
 * Bans the user until `expiresAt` (null: for good) unless a running ban
 * already lasts as long. issued says whether a new row was written; until is
 * the end that now holds.
 */
export async function banUntil(
  supabase: SupabaseClient,
  ban: { userId: string; issuedBy: string; reason: string; expiresAt: string | null },
): Promise<{ id: string | null; until: string | null; issued: boolean } | null> {
  const running = await activeBanFor(supabase, ban.userId);
  if (running && laterEnd(running.expiresAt, ban.expiresAt) === running.expiresAt) {
    return { id: running.id, until: running.expiresAt, issued: false };
  }
  const { data, error } = await supabase
    .from("bans")
    .insert({ user_id: ban.userId, issued_by: ban.issuedBy, scope: "full", reason: ban.reason, expires_at: ban.expiresAt })
    .select("id")
    .single();
  return error ? null : { id: (data?.id as string | undefined) ?? null, until: ban.expiresAt, issued: true };
}
