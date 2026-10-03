/**
 * 18+ content (Kev, 2026-10-03): 18+ or below, no age classes yet.
 *
 * A user confirms in Settings that they are 18 or older. Only then does the
 * feed show an 18+ pill, and it stays off until they turn it on. Every list
 * or page that shows other people's prompts or images leaves 18+ out unless
 * the viewer is confirmed AND has the pill on (the X-Show-Adult header);
 * owners always see their own. Generating something the prompt check marks
 * 18+ needs the confirmation; agents cannot give it.
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

/** Whether any of these URLs is one of our renders marked 18+: a prompt showing one is 18+ itself. */
export async function showsAdultRender(supabase: SupabaseClient, urls: string[]): Promise<boolean> {
  if (urls.length === 0) return false;
  const hits = await Promise.all(["storage_url", "preview_url", "thumbnail_url"].map((column) =>
    supabase.from("generated_images").select("id").eq("is_adult", true).in(column, urls).limit(1)));
  return hits.some((r) => (r.data ?? []).length > 0);
}
