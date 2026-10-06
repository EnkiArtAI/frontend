import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * How many images an account may generate for free.
 *
 * Kev, 2026-08-18: free usage is an onboarding allowance for new accounts,
 * not a permanent tier — "3 pro account wären super".
 *
 * Counted from free_generation_claims (ENG-20), one row per free render,
 * claimed before the render and given back only when it fails. Changing this
 * number changes the allowance immediately, with nothing to migrate.
 */
export const FREE_GENERATIONS_PER_ACCOUNT = 3;

export interface FreeQuota {
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
}

/**
 * What this account has already spent of its free allowance: its claims.
 *
 * Not its generations rows. Those were written only after the response, so
 * parallel requests all read the same count, a failed insert was never
 * counted, and a paid render (amount_paid_cents never written) ate the free
 * allowance. Not a provider name either: `provider = 'pollinations'` would
 * reset everyone's allowance the day the free provider changed.
 *
 * Deleting a generation refunds nothing. A generation that happened, happened.
 */
export async function freeQuotaFor(
  supabase: SupabaseClient,
  userId: string,
): Promise<FreeQuota> {
  const { count, error } = await supabase
    .from("free_generation_claims")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  /* A failed count must not hand out free generations. The alternative —
     treating an outage as "0 used" — turns a database blip into an unlimited
     free tier, which is the expensive direction to be wrong in. */
  if (error) throw new Error(`free quota lookup failed: ${error.message}`);

  const used = count ?? 0;
  const limit = FREE_GENERATIONS_PER_ACCOUNT;
  return { used, limit, remaining: Math.max(0, limit - used), exhausted: used >= limit };
}

/** Roles that carry the team's own access. Same set app/api/admin gates on. */
const TEAM_ROLES = new Set(["admin", "mod"]);

export type FreeDecision =
  // claimId null: the team, which claims nothing.
  | { allowed: true; claimId: string | null }
  | { allowed: false; reason: "sign-in" | "quota"; quota: FreeQuota | null };

/**
 * May this caller generate for free, and what is left.
 *
 * Three rules, in this order:
 *
 *  1. No session, no free generation. Not a policy preference — an anonymous
 *     caller has no user_id, so there is nothing for a per-account allowance
 *     to count against. The only handle on them is an IP, which whole offices
 *     and mobile networks share and which anyone can change by toggling
 *     flight mode. Leaving them unlimited made the allowance decorative:
 *     the way around three-per-account was to log out.
 *  2. The team generates without a limit while the beta runs (Kev,
 *     2026-08-18). Read from users.role, the same marker app/api/admin gates
 *     on, so granting it to someone else is a role change rather than a
 *     deploy.
 *  3. Everyone else gets the allowance, claimed atomically here: the
 *     database takes one claim at a time per account, so ten parallel
 *     requests get at most what is left.
 */
export async function freeGenerationDecision(
  supabase: SupabaseClient,
  userId: string | null,
): Promise<FreeDecision> {
  if (!userId) return { allowed: false, reason: "sign-in", quota: null };

  const { data, error } = await supabase
    .from("users")
    .select("role")
    .eq("id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  /* A failed role lookup falls through to the allowance rather than granting
     the team's exemption — an outage must not hand anyone unlimited free
     generation, and the allowance below still protects the account. */
  if (!error && data && TEAM_ROLES.has(String((data as { role?: string }).role ?? ""))) {
    return { allowed: true, claimId: null };
  }

  const { data: claimId, error: claimErr } = await supabase.rpc("claim_free_generation", {
    p_user_id: userId,
    p_limit: FREE_GENERATIONS_PER_ACCOUNT,
  });
  // A failed claim must not hand out a free generation, like a failed count.
  if (claimErr) throw new Error(`free claim failed: ${claimErr.message}`);
  return claimId
    ? { allowed: true, claimId: String(claimId) }
    : { allowed: false, reason: "quota", quota: await freeQuotaFor(supabase, userId) };
}

/** A render that failed gives its claim back: the allowance counts images made, not attempts. */
export async function releaseFreeClaim(supabase: SupabaseClient | null, claimId: string | null): Promise<void> {
  if (!supabase || !claimId) return;
  const { error } = await supabase.from("free_generation_claims").delete().eq("id", claimId);
  if (error) console.warn("[free-quota] claim not given back:", error.message);
}
