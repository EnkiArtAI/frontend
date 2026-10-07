import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Approvals a recovery needs: the stored threshold (2 by default), never more
 * than the owner's confirmed guardians. Above that a recovery could never
 * complete, and nobody would know until the day it is needed.
 */
export async function recoveryThreshold(supabase: SupabaseClient, userId: string): Promise<number> {
  const [{ data }, { count, error }] = await Promise.all([
    supabase.from("recovery_settings").select("threshold").eq("user_id", userId).maybeSingle(),
    supabase.from("recovery_guardians").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "confirmed"),
  ]);
  const stored: number = data?.threshold ?? 2;
  // Guardians that cannot be counted lower nothing: an error never eases a reset.
  return error || count === null ? stored : Math.max(1, Math.min(stored, count));
}
