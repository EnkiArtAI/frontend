/**
 * One rule for every ban that lands on a running one: the running ban is
 * extended to the later end, never shortened and never doubled. A second,
 * shorter row was reported as the end (activeBanFor reads the newest), and a
 * skipped ban let a permanent child-safety ban vanish behind a 3-day
 * suspension.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { activeBanFor } from "@/lib/session-user";

/** The later of two ends, null being for good. Compared as instants, not as strings. */
export function laterEnd(running: string | null, next: string | null): string | null {
  if (running === null || next === null) return null;
  return Date.parse(running) >= Date.parse(next) ? running : next;
}

/** Bans the user until `expiresAt` (null: for good), extending a running ban rather than adding one. */
export async function banUntil(
  supabase: SupabaseClient,
  ban: { userId: string; issuedBy: string; reason: string; expiresAt: string | null },
): Promise<{ id: string | null; until: string | null } | null> {
  const running = await activeBanFor(supabase, ban.userId);
  if (running) {
    const end = laterEnd(running.expiresAt, ban.expiresAt);
    if (end !== running.expiresAt) {
      const { error } = await supabase.from("bans").update({ expires_at: end }).eq("id", running.id);
      if (error) return null;
    }
    return { id: running.id, until: end };
  }
  const { data, error } = await supabase
    .from("bans")
    .insert({ user_id: ban.userId, issued_by: ban.issuedBy, scope: "full", reason: ban.reason, expires_at: ban.expiresAt })
    .select("id")
    .single();
  return error ? null : { id: (data?.id as string | undefined) ?? null, until: ban.expiresAt };
}
