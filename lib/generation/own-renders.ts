import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Which of these URLs are recorded renders of these users: made on Enki, not
 * uploaded, not deleted, known by their original or their preview. Until an
 * image check runs on uploads, only such renders may be shown publicly as a
 * prompt's showcase (Kev, 2026-10-08). null when the lookup failed: callers
 * refuse rather than guess.
 */
export async function ownRenders(supabase: SupabaseClient, userIds: string[], urls: string[]): Promise<Set<string> | null> {
  const web = urls.filter((url) => /^https:\/\//.test(url));
  if (web.length === 0 || userIds.length === 0) return new Set();
  const read = (column: "storage_url" | "preview_url") =>
    supabase
      .from("generated_images")
      .select("storage_url, preview_url")
      .in("user_id", userIds)
      .eq("is_uploaded", false)
      .is("deleted_at", null)
      .in(column, web);
  const [byOriginal, byPreview] = await Promise.all([read("storage_url"), read("preview_url")]);
  if (byOriginal.error || byPreview.error) return null;
  return new Set(
    [...(byOriginal.data ?? []), ...(byPreview.data ?? [])]
      .flatMap((row) => [row.storage_url, row.preview_url])
      .filter((url): url is string => typeof url === "string" && web.includes(url)),
  );
}
