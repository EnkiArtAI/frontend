/**
 * 18+ content (Kev, 2026-10-03): 18+ or below, no age classes yet.
 *
 * A user confirms in Settings that they are 18 or older. Only then does the
 * feed show an 18+ pill, and it stays off until they turn it on. Every list
 * or page that shows other people's prompts or images leaves 18+ out unless
 * the viewer is confirmed AND has the pill on (the X-Show-Adult header);
 * owners always see their own. Generating something the prompt check marks
 * 18+ needs the confirmation. An agent cannot give it and is not asked to:
 * it gets 18+ like anything else the checks let through, explicit stays
 * refused (Kev, 2026-10-03).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSessionUserId } from "@/lib/session-user";

export const SHOW_ADULT_HEADER = "X-Show-Adult";

export const ADULT_REFUSAL = {
  error: "This is 18+ content. Confirm that you are 18 or older in Settings to generate it. Nothing was generated and nothing was charged.",
  code: "adult_unconfirmed",
} as const;

export async function adultConfirmed(supabase: SupabaseClient, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const { data } = await supabase.from("users").select("adult_confirmed_at").eq("id", userId).maybeSingle();
  return Boolean(data?.adult_confirmed_at);
}

type Viewer = { userId: string | null; showAdult: boolean };

/** Who is looking, and whether they may see 18+. A lookup that fails shows the safe view. */
export async function viewer(
  supabase: SupabaseClient,
  req: { headers: { get(name: string): string | null } },
): Promise<Viewer> {
  const token = req.headers.get("X-Session-Token");
  const userId = token ? await resolveSessionUserId(supabase, token).catch(() => null) : null;
  const wants = req.headers.get(SHOW_ADULT_HEADER) === "1";
  return { userId, showAdult: wants && (await adultConfirmed(supabase, userId).catch(() => false)) };
}

/** 18+ shows to a viewer who may see it, and to its owner. */
export function mayShowAdult(v: Viewer, ownerId?: string | null): boolean {
  return v.showAdult || (ownerId != null && ownerId === v.userId);
}

/** Leaves 18+ rows out of a read unless `mayShowAdult`. */
export function hideAdult<Q extends { eq(column: string, value: boolean): Q }>(query: Q, v: Viewer, ownerId?: string | null): Q {
  return mayShowAdult(v, ownerId) ? query : query.eq("is_adult", false);
}

/**
 * Whether any of these URLs is one of our renders marked 18+: a prompt showing
 * one is 18+ itself. null when the lookup failed: callers refuse rather than
 * store a guess either way.
 */
export async function showsAdultRender(supabase: SupabaseClient, urls: string[]): Promise<boolean | null> {
  // Only web URLs can be looked up; a multi-megabyte data: URL in a query
  // string fails the request. Those are left to the image check (stage 2).
  const web = urls.filter((u) => /^https:\/\//.test(u));
  if (web.length === 0) return false;
  const hits = await Promise.all(["storage_url", "preview_url", "thumbnail_url"].map((column) =>
    supabase.from("generated_images").select("id").eq("is_adult", true).in(column, web).limit(1)));
  if (hits.some((r) => r.error)) return null;
  return hits.some((r) => (r.data ?? []).length > 0);
}

/**
 * A stored prompt's own 18+ mark; its title or showcase can make it 18+ when
 * the text alone does not. null when the read failed: callers refuse rather
 * than guess, so a passing error never leaves a lasting mark.
 */
export async function promptMarkedAdult(supabase: SupabaseClient, promptId: string | null): Promise<boolean | null> {
  if (!promptId) return false;
  const { data, error } = await supabase.from("prompts").select("is_adult").eq("id", promptId).maybeSingle();
  if (error) return null;
  return data?.is_adult === true;
}

/** Of these prompts, the 18+ ones this viewer may not see (their own never are); null when the lookup failed. */
export async function hiddenAdultPrompts(supabase: SupabaseClient, v: Viewer, promptIds: string[]): Promise<Set<string> | null> {
  if (v.showAdult || promptIds.length === 0) return new Set();
  let q = supabase.from("prompts").select("id").in("id", promptIds).eq("is_adult", true);
  if (v.userId) q = q.neq("creator_id", v.userId);
  const { data, error } = await q;
  return error ? null : new Set((data ?? []).map((p) => String(p.id)));
}
