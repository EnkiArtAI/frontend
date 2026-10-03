/**
 * An agent's inputs for a marketplace prompt, checked before anything is
 * quoted or paid.
 *
 * Only a live prompt can be generated from: drafts, unlisted and deleted ones
 * are not for sale. Every value must belong to a declared variable and fit it,
 * so an agent never pays for an input that would be ignored. For a paid
 * prompt the composed text contains the artist's secret, and a free value is
 * an instruction to the image model, which can be told to typeset the words
 * around it: there, text values are also short single lines without brackets.
 * That narrows the hole; a short text value is still an instruction, a
 * residual risk the product accepts or closes deliberately.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isListed, isPublicText } from "@/lib/prompt-visibility";
import { VALUE_MAX } from "@/lib/generation/prompt-text";

/** The longest text value an agent may send: the same limit as every buyer's (Kev, 2026-10-03: 300). */
export const AGENT_TEXT_MAX = VALUE_MAX;

type Declared = {
  name: string;
  label: string | null;
  data_type: string | null;
  options: unknown;
  min_value: number | null;
  max_value: number | null;
};

export type AgentInputs =
  | { ok: true; paid: boolean; variables: Declared[]; values: Map<string, string> }
  | { ok: false; status: 400 | 404 | 500; error: string };

/**
 * The name app/api/prompt stores a slot as (toDbVarName, before its
 * tie-breaks). Null for a slot with no ASCII letter or digit ("[名前]"): that
 * one is stored as var_<position>, which its text cannot be traced back to.
 */
function storedName(slot: string): string | null {
  const s = slot.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) return null;
  return /^[a-z]/.test(s) ? s : `v_${s}`;
}

/** A variable stored as var_<position>: no [slot] resolves to it. */
const unreachable = (v: Declared) => /^var_\d+$/.test(v.name);

/**
 * The declared variable a key or a [slot] names: its stored name exactly,
 * else the name the slot's text was stored as ("Hero Name" is hero_name).
 * Labels are never used: they hold the text the creator selected, not the
 * slot, and could hand one variable's value to another.
 */
function variableFor(variables: Declared[], key: string): Declared | undefined {
  const k = key.trim();
  const stored = storedName(k);
  return variables.find((v) => k === v.name) ?? (stored ? variables.find((v) => stored === v.name) : undefined);
}

function optionValues(options: unknown): string[] {
  return Array.isArray(options)
    ? options
        .map((o) => (typeof o === "string" ? o : (o as { promptValue?: unknown })?.promptValue))
        .filter((v): v is string => typeof v === "string")
    : [];
}

/** The value as it enters the prompt, or why it may not. */
function fit(v: Declared, raw: string, paid: boolean): { value: string } | { error: string } {
  const bad = { error: `"${raw}" is not a valid value for ${v.name}` };
  switch (v.data_type) {
    case "single_select":
      return optionValues(v.options).includes(raw) ? { value: raw } : bad;
    case "multi_select": {
      const allowed = optionValues(v.options);
      const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
      return parts.length > 0 && parts.every((p) => allowed.includes(p)) ? { value: parts.join(", ") } : bad;
    }
    case "slider": {
      const n = Number(raw);
      const inRange = Number.isFinite(n) && (v.min_value == null || n >= v.min_value) && (v.max_value == null || n <= v.max_value);
      return raw.trim() !== "" && inRange ? { value: String(n) } : bad;
    }
    case "checkbox":
      // As the generator does it: a ticked box writes its phrase, an unticked one nothing.
      return raw === "true" || raw === "false" ? { value: raw === "true" ? v.label || v.name : "" } : bad;
    default: {
      // A paid prompt's text values are short single lines without brackets;
      // every text value keeps the one length limit of both rails.
      const value = paid ? raw.replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim() : raw;
      return value.length <= AGENT_TEXT_MAX ? { value } : { error: `${v.name} takes at most ${AGENT_TEXT_MAX} characters` };
    }
  }
}

export async function checkAgentPromptInputs(
  supabase: SupabaseClient,
  promptId: string,
  values: Record<string, string> | undefined,
): Promise<AgentInputs> {
  const { data: row, error } = await supabase
    .from("prompts")
    .select("prompt_type, is_free_showcase, is_listed, listing_status, deleted_at")
    .eq("id", promptId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: "Failed to load prompt" };
  if (!row || !isListed(row)) return { ok: false, status: 404, error: "Prompt not found" };
  const paid = !isPublicText(row);

  const { data: rows, error: varsError } = await supabase
    .from("prompt_variables")
    .select("name, label, data_type, options, min_value, max_value")
    .eq("prompt_id", promptId)
    .is("deleted_at", null);
  if (varsError) return { ok: false, status: 500, error: "Failed to load the prompt's variables" };
  const variables = (rows ?? []) as Declared[];

  const fitted = new Map<string, string>();
  for (const [key, raw] of Object.entries(values ?? {})) {
    const v = variableFor(variables, key);
    if (!v) return { ok: false, status: 400, error: `This prompt has no variable "${key}"` };
    // Refused rather than paid for and dropped: its slot cannot be found.
    if (unreachable(v)) return { ok: false, status: 400, error: `${v.name} cannot be filled through the API` };
    const r = fit(v, raw, paid);
    if ("error" in r) return { ok: false, status: 400, error: r.error };
    fitted.set(v.name, r.value);
  }
  return { ok: true, paid, variables, values: fitted };
}

