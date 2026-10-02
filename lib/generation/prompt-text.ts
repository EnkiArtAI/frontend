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

/** A stored variable, by the name app/api/prompt saved it under. */
export interface StoredVariable {
  name: string;
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
    .select("name")
    .eq("prompt_id", promptId)
    .is("deleted_at", null)
    .order("position", { ascending: true });
  const variables = ((vars ?? []) as Array<{ name?: unknown }>)
    .filter((v) => typeof v.name === "string")
    .map((v) => ({ name: String(v.name) }));
  return { ok: true, text, variables };
}

/** The slug app/api/prompt stores a variable name as (chk_var_name_format). */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * The name app/api/prompt's toDbVarName saved a slot under, before its
 * tie-breaks: the slug, with "v_" in front when it does not start with a
 * letter ("2nd subject" -> v_2nd_subject). Null when nothing survives the
 * slug (a name with no ASCII letters or digits is saved as var_N, which the
 * slot text cannot be traced back to).
 */
function storedName(slotText: string): string | null {
  const s = slug(slotText);
  if (!s) return null;
  return /^[a-z]/.test(s) ? s : `v_${s}`;
}

export interface Filled {
  text: string;
  /** Slots no value was found for. */
  unfilled: string[];
  /** Stored variables a value arrived for that no slot took. */
  unused: string[];
  /** Two different slots answer to one stored name, so one would take the other's value. */
  ambiguous: boolean;
}

/**
 * Fill the [slots] with the buyer's values. The artist's text keeps a slot
 * as typed ("[Character Design]") while the stored name, and so the key the
 * buyer's values arrive under, is what toDbVarName made of it
 * ("character_design", "v_2nd_subject"). Each slot resolves by its exact
 * text, then by that stored name, then by its plain slug (an agent sending
 * its own keys). Labels are never used: they hold the text the artist
 * selected, not the slot, and could hand one variable's value to another.
 */
export function fillVariables(text: string, values: unknown, variables: StoredVariable[] = []): Filled {
  const vals = values && typeof values === "object" ? (values as Record<string, unknown>) : {};
  const names = new Set(variables.map((v) => v.name));
  const used = new Set<string>();
  const unfilled: string[] = [];
  const slotBySn = new Map<string, string>();
  let ambiguous = false;

  const take = (key: string | null | undefined) => {
    const v = key ? vals[key] : undefined;
    if (typeof v !== "string" || v.length > 2000) return undefined;
    used.add(key as string);
    return v;
  };

  const out = text.replace(/\[([^\]\n]+)\]/g, (slot, name: string) => {
    const sn = storedName(name);
    if (sn && names.has(sn)) {
      const seen = slotBySn.get(sn);
      if (seen !== undefined && seen !== name) ambiguous = true;
      slotBySn.set(sn, name);
    }
    const v = take(name) ?? (sn && names.has(sn) ? take(sn) : undefined) ?? take(slug(name));
    if (v === undefined) {
      unfilled.push(name);
      return slot;
    }
    return v;
  });

  const unused = variables.map((v) => v.name).filter((n) => !used.has(n) && typeof vals[n] === "string");
  return { text: out, unfilled, unused, ambiguous };
}

/** True when the buyer's inputs cannot be matched to the text with certainty. */
export function inputsUnmatched(f: Filled): boolean {
  return f.ambiguous || (f.unfilled.length > 0 && f.unused.length > 0);
}
