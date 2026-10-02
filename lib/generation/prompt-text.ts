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

export type PromptTextResult =
  | { ok: true; text: string }
  | { ok: false; status: 422 | 500; error: string };

export async function loadPromptText(supabase: SupabaseClient, promptId: string): Promise<PromptTextResult> {
  const { data: row, error } = await supabase
    .from("prompts")
    .select("public_prompt_text, encrypted_content, encrypted_content_iv, encrypted_content_tag, encrypted_content_kid")
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
      text = "";
    }
  }
  if (!text.trim()) text = String(row.public_prompt_text ?? "");
  if (!text.trim()) return { ok: false, status: 422, error: "This prompt has no readable text to generate from" };
  return { ok: true, text };
}

/** Fill the same [name] slots the human UI shows. Unknown or non-text values leave the slot as written. */
export function fillVariables(text: string, values: unknown): string {
  const vars = values && typeof values === "object" ? (values as Record<string, unknown>) : {};
  return text.replace(/\[([^\]\n]+)\]/g, (slot, name: string) => {
    const v = vars[name];
    return typeof v === "string" && v.length <= 2000 ? v : slot;
  });
}
