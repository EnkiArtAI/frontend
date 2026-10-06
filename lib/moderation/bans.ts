/**
 * One rule for every ban that lands on a running one: each sanction is its
 * own row, never merged into another, so each keeps its reason and its
 * appeal, and lifting one (an approved appeal) leaves the others in force.
 * Only the same sanction again (an active ban with the same reason, which is
 * why automated reasons carry no counters) that lasts as long adds nothing:
 * the rows a user can collect stay bounded. activeBanFor reports the ban that lasts longest, so a shorter
 * row never hides a longer one. Dropping a ban that ended no later let it
 * vanish with the one it was dropped for, on that one's appeal.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { activeBanFor } from "@/lib/session-user";

/** The later of two ends, null being for good. Compared as instants, not as strings. */
export function laterEnd(running: string | null, next: string | null): string | null {
  if (running === null || next === null) return null;
  return Date.parse(running) >= Date.parse(next) ? running : next;
}

/**
 * Bans the user until `expiresAt` (null: for good) unless the same sanction
 * already runs at least as long. issued says whether a new row was written;
 * until is the end that now holds.
 */
export async function banUntil(
  supabase: SupabaseClient,
  ban: { userId: string; issuedBy: string; reason: string; expiresAt: string | null },
): Promise<{ id: string | null; until: string | null; issued: boolean } | null> {
  const running = await activeBanFor(supabase, ban.userId);
  // Any active row of this sanction, not only the longest ban: several
  // sources take turns being the newest row.
  const { data: same, error: sameErr } = await supabase
    .from("bans")
    .select("id, expires_at")
    .eq("user_id", ban.userId)
    .eq("reason", ban.reason)
    .is("lifted_at", null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("expires_at", { ascending: false, nullsFirst: true })
    .limit(1);
  if (sameErr) return null;
  const covering = (same ?? [])[0] as { id: string; expires_at: string | null } | undefined;
  if (covering && laterEnd(covering.expires_at ?? null, ban.expiresAt) === (covering.expires_at ?? null)) {
    return { id: String(covering.id), until: running?.expiresAt ?? covering.expires_at ?? null, issued: false };
  }
  const until = running ? laterEnd(running.expiresAt, ban.expiresAt) : ban.expiresAt;
  const { data, error } = await supabase
    .from("bans")
    .insert({ user_id: ban.userId, issued_by: ban.issuedBy, scope: "full", reason: ban.reason, expires_at: ban.expiresAt })
    .select("id")
    .single();
  return error ? null : { id: (data?.id as string | undefined) ?? null, until, issued: true };
}
