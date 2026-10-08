import type { SupabaseClient } from "@supabase/supabase-js";
import { isListed, isPublicText } from "@/lib/prompt-visibility";

export type FreeRenderPrompt = {
  /** The prompt is marked 18+. */
  adult: boolean;
  /** Someone else's prompt on sale whose text is paid: the free model never saw it. */
  paid: boolean;
  /** The prompt the render is recorded under, or null for none. */
  creditId: string | null;
};

/**
 * The prompt a free render names (Kev, 2026-10-08). The free model renders
 * only the text the client sends, never a paid prompt's, so someone else's
 * paid prompt on sale is refused. A render is credited to a prompt only when
 * that prompt is on sale with its text public, or is the caller's own (an
 * artist rendering their draft); otherwise it names none, and a stranger can
 * never put renders under another creator's prompt. null when the lookup
 * failed: the caller refuses rather than guesses.
 */
export async function freeRenderPrompt(
  supabase: SupabaseClient,
  promptId: string | null,
  callerIds: string[],
): Promise<FreeRenderPrompt | null> {
  if (!promptId) return { adult: false, paid: false, creditId: null };
  const { data, error } = await supabase
    .from("prompts")
    .select("id, creator_id, is_adult, is_listed, listing_status, deleted_at, prompt_type, is_free_showcase")
    .eq("id", promptId)
    .maybeSingle();
  if (error) return null;
  if (!data) return { adult: false, paid: false, creditId: null };
  const own = callerIds.includes(String(data.creator_id));
  return {
    adult: data.is_adult === true,
    paid: !own && isListed(data) && !isPublicText(data),
    creditId: own || (isListed(data) && isPublicText(data)) ? String(data.id) : null,
  };
}
