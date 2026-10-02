/**
 * The text of a marketplace prompt, read on the server.
 *
 * A paid prompt's body is encrypted at rest and never leaves the server: the
 * buyer pays for generations from it, not for the text. Both paid rails build
 * the final prompt here from the stored text and the buyer's variable values.
 * The human rail used to generate from whatever the client sent, which for a
 * paid prompt was the title plus the variables, so the buyer paid the artist
 * and got an image that was not made from the artist's prompt.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptPrompt } from "@/backend/encryption";

/** A stored variable: its slugged name and the label the artist typed. */
export interface StoredVariable {
  name: string;
  label: string | null;
}

export type PromptTextResult =
  | { ok: true; text: string; variables: StoredVariable[] }
  | { ok: false; status: 422 | 500; error: string };

export async function loadPromptText(supabase: SupabaseClient, promptId: string): Promise<PromptTextResult> {
  const { data: row, error } = await supabase
    .from("prompts")
    .select("public_prompt_text, encrypted_content, encrypted_content_iv, encrypted_content_tag, encrypted_content_kid, price_usd_cents, prompt_type, is_free_showcase")
    .eq("id", promptId)
    .maybeSingle();
  if (error || !row) return { ok: false, status: 500, error: "Failed to load prompt" };

  let text = "";
  if (row.encrypted_content) {
    try {
      text = decryptPrompt({
        encryptedContent: String(row.encrypted_content),
        iv: String(row.encrypted_content_iv ?? ""),
        authTag: String(row.encrypted_content_tag ?? ""),
        kid: row.encrypted_content_kid ? String(row.encrypted_content_kid) : undefined,
      });
    } catch {
      console.error("[prompt-text] could not decrypt prompt", promptId);
      text = "";
    }
  }
  /* A priced prompt never falls back to its public excerpt (the first 220
     characters): the buyer would pay the artist for an image the artist's
     prompt never made. Refused before anything is charged. Free and showcase
     prompts are public text anyway. */
  const priced =
    Number(row.price_usd_cents) > 0 &&
    row.prompt_type !== "showcase" &&
    row.prompt_type !== "free-prompt" &&
    row.is_free_showcase !== true;
  if (!text.trim() && priced) {
    return { ok: false, status: 500, error: "This prompt's text cannot be read right now. Nothing was generated and nothing was charged." };
  }
  if (!text.trim()) text = String(row.public_prompt_text ?? "");
  if (!text.trim()) return { ok: false, status: 422, error: "This prompt has no readable text to generate from" };

  const { data: vars } = await supabase
    .from("prompt_variables")
    .select("name, label")
    .eq("prompt_id", promptId)
    .is("deleted_at", null);
  const variables = ((vars ?? []) as Array<{ name?: unknown; label?: unknown }>)
    .filter((v) => typeof v.name === "string")
    .map((v) => ({ name: String(v.name), label: typeof v.label === "string" ? v.label : null }));
  return { ok: true, text, variables };
}

/** The slug app/api/prompt stores a variable name as (chk_var_name_format). */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * Fill the [slots] with the buyer's values. The artist's text keeps the slot
 * as typed ("[Character Design]") while the stored name, and so the key the
 * buyer's values arrive under, is its slug ("character_design"), sometimes
 * with a prefix ("2nd subject" is stored as v_2nd_subject, label kept). Each
 * slot therefore resolves the way the buyer UI resolves it: exact text, then
 * a stored variable whose name, name slug or label slug matches. Unknown or
 * non-text values leave the slot as written.
 */
export function fillVariables(text: string, values: unknown, variables: StoredVariable[] = []): string {
  const vals = values && typeof values === "object" ? (values as Record<string, unknown>) : {};
  const stored = new Map<string, string>();
  for (const v of variables) {
    for (const k of [v.name, slug(v.name), v.label ? slug(v.label) : ""]) {
      if (k && !stored.has(k)) stored.set(k, v.name);
    }
  }
  return text.replace(/\[([^\]\n]+)\]/g, (slot, name: string) => {
    const keys = [name, stored.get(name), stored.get(slug(name)), slug(name)];
    for (const k of keys) {
      const v = k ? vals[k] : undefined;
      if (typeof v === "string" && v.length <= 2000) return v;
    }
    return slot;
  });
}
