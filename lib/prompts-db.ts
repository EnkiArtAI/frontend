/**
 * Supabase-backed prompt reads/writes.
 *
 * Replaces the dead MongoDB `backend/storage` layer. Shapes are intentionally
 * minimal — they carry exactly the fields the callers read. Column names match
 * the live `prompts` table (see app/api/prompt/route.ts, the authoritative
 * writer): encrypted_content / iv / auth_tag / user_id / uploaded_photos, etc.
 *
 * Post-consolidation, prompt ownership is `user_id` only — there is no
 * `artistId`. `artistId` is exposed as `undefined` so legacy `prompt.userId ||
 * prompt.artistId` and `prompt.artistId === userId` call sites keep compiling
 * without changing behaviour.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface DbPrompt {
  id: string;
  title: string;
  userId: string | undefined;
  /** legacy alias, always undefined post-consolidation */
  artistId: undefined;
  price: number;
  createdAt: string | undefined;
  previewImageUrl: string | undefined;
  promptType: string | undefined;
  isFreeShowcase: boolean;
}

export interface DbPromptVariable {
  id: string | undefined;
  name: string;
  label: string;
  description: string;
  type: string;
  defaultValue: unknown;
  required: boolean;
  position: number;
  min: number | null;
  max: number | null;
  options: unknown;
}

function mapPromptRow(row: Record<string, unknown>): DbPrompt {
  const photos = row.uploaded_photos;
  return {
    id: String(row.id),
    title: typeof row.title === "string" ? row.title : "",
    userId: (row.user_id as string | null | undefined) ?? undefined,
    artistId: undefined,
    price: typeof row.price === "number" ? row.price : 0,
    createdAt: (row.created_at as string | null | undefined) ?? undefined,
    previewImageUrl: Array.isArray(photos)
      ? (photos[0] as string | undefined)
      : undefined,
    promptType: (row.prompt_type as string | null | undefined) ?? undefined,
    isFreeShowcase: Boolean(row.is_free_showcase),
  };
}

/**
 * Fetch a single prompt by id. Returns undefined when not found (mirrors the
 * old storage.getPrompt contract).
 */
export async function getPromptById(
  supabase: SupabaseClient,
  id: string
): Promise<DbPrompt | undefined> {
  const { data, error } = await supabase
    .from("prompts")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return undefined;
  return mapPromptRow(data as Record<string, unknown>);
}

/**
 * Fetch a prompt's variables, ordered by position. Empty array when none.
 */
export async function getPromptVariables(
  supabase: SupabaseClient,
  promptId: string
): Promise<DbPromptVariable[]> {
  const { data, error } = await supabase
    .from("variables")
    .select("*")
    .eq("prompt_id", promptId)
    .order("position", { ascending: true });

  if (error) throw error;

  return (data || []).map((v: Record<string, unknown>) => ({
    id: typeof v.id === "string" ? v.id : undefined,
    name: String(v.name ?? ""),
    label: String(v.label ?? ""),
    description: typeof v.description === "string" ? v.description : "",
    type: String(v.type ?? ""),
    defaultValue: v.default_value ?? null,
    required: Boolean(v.required),
    position: typeof v.position === "number" ? v.position : 0,
    min: typeof v.min === "number" ? v.min : null,
    max: typeof v.max === "number" ? v.max : null,
    options: v.options ?? null,
  }));
}

/**
 * Update marketplace/listing fields on a prompt, scoped by owner ids.
 * Returns the row count updated (0 = not found or not owned).
 *
 * WRITE COLUMNS: only keys present in `patch` are written. Callers currently
 * write: price, tags, category, updated_at. See PR body for the full list the
 * founder must confirm exist in the `prompts` table.
 */
export async function updatePromptOwned(
  supabase: SupabaseClient,
  id: string,
  ownerIds: string[],
  patch: Record<string, unknown>
): Promise<number> {
  const { error, count } = await supabase
    .from("prompts")
    .update(patch, { count: "exact" })
    .eq("id", id)
    .in("user_id", ownerIds);

  if (error) throw error;
  return count ?? 0;
}
