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
import { isPublicText } from "@/lib/prompt-visibility";
import { dbOutage, isDbUnreachable, type DbOutage } from "@/lib/db-error";
import { slug, storedName } from "@/lib/generation/stored-name";

export { storedName };

/** A stored variable, by the name app/api/prompt saved it under. */
export interface StoredVariable {
  name: string;
}

export type PromptTextResult =
  | { ok: true; text: string; variables: StoredVariable[]; adult: boolean }
  | { ok: false; status: 422 | 500; error: string }
  | DbOutage;

export async function loadPromptText(supabase: SupabaseClient, promptId: string): Promise<PromptTextResult> {
  const { data: row, error } = await supabase
    .from("prompts")
    .select("public_prompt_text, encrypted_content, encrypted_content_iv, encrypted_content_tag, encrypted_content_kid, price_usd_cents, prompt_type, is_free_showcase, is_adult")
    .eq("id", promptId)
    .maybeSingle();
  if (isDbUnreachable(error)) return dbOutage();
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
  const priced = Number(row.price_usd_cents) > 0 && !isPublicText(row);
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
  return { ok: true, text, variables, adult: row.is_adult === true };
}

/**
 * The longest value a buyer may put into a slot (Kev, 2026-10-02: 300). A
 * length cap does not stop an extraction attempt, the checker on the values
 * does; it keeps the values a slot's worth of text.
 */
export const VALUE_MAX = 300;

/** The first buyer value longer than VALUE_MAX, refused before anything is charged. */
export function overLong(values: unknown): string | null {
  if (!values || typeof values !== "object") return null;
  const hit = Object.entries(values as Record<string, unknown>).find(([, v]) => typeof v === "string" && v.length > VALUE_MAX);
  return hit ? hit[0] : null;
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
  /* Ambiguity, decided before filling. When two different slots slug alike
     ("[Hero]", "[hero!]"), toDbVarName saved the second as a tie-break
     (hero_2, hero_3, …) that no slot's own name produces. A tie-break name
     that no slot names itself therefore means the text cannot say which
     value belongs where. One slot written twice ("[subject]", "[ subject ]")
     is one variable and has no tie-break; a typed "hero 2" names hero_2
     itself and is not one. */
  const slotted = new Set<string>();
  for (const m of text.matchAll(/\[([^\]\n]+)\]/g)) {
    const sn = storedName(m[1]);
    if (sn && names.has(sn)) slotted.add(sn);
  }
  const tieBreakOf = (n: string, sn: string) => n.startsWith(`${sn}_`) && /^\d+$/.test(n.slice(sn.length + 1));
  const ambiguous = [...slotted].some((sn) => [...names].some((n) => tieBreakOf(n, sn) && !slotted.has(n)));

  const take = (key: string | null | undefined) => {
    const v = key ? vals[key] : undefined;
    if (typeof v !== "string" || v.length > VALUE_MAX) return undefined;
    used.add(key as string);
    return v;
  };

  const out = text.replace(/\[([^\]\n]+)\]/g, (slot, name: string) => {
    const sn = storedName(name);
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
