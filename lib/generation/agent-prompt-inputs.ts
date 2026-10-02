/**
 * An agent's inputs for a marketplace prompt, checked before anything is
 * quoted or paid.
 *
 * Only a live prompt can be generated from: drafts, unlisted and deleted ones
 * are not for sale. For a paid prompt the composed text contains the artist's
 * secret, and a free value is an instruction to the image model, which can be
 * told to typeset the words around it. So every value must belong to a
 * declared variable and fit it, and text values are short single lines
 * without brackets. That narrows the hole; a short text value is still an
 * instruction, a residual risk the product accepts or closes deliberately.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isListed, isPublicText } from "@/lib/prompt-visibility";

/** The longest text value a paid prompt accepts from an agent. */
export const AGENT_TEXT_MAX = 100;

type Declared = {
  name: string;
  label: string | null;
  data_type: string | null;
  options: unknown;
  min_value: number | null;
  max_value: number | null;
};

export type AgentInputs =
  | { ok: true; paid: false }
  | { ok: true; paid: true; variables: Declared[]; values: Map<string, string> }
  | { ok: false; status: 400 | 404 | 500; error: string };

/** The slug app/api/prompt stores a variable name as. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * The declared variable a key or a [slot] names: its stored name or its label
 * exactly, else the slug the name was stored as. Exact first, because two
 * slots that slug alike were stored as tie-breaks ("Hero" as hero, "hero!" as
 * hero_2) and only the label tells them apart.
 */
function variableFor(variables: Declared[], key: string): Declared | undefined {
  const k = key.trim();
  return variables.find((v) => k === v.name || k === v.label) ?? variables.find((v) => slug(k) === v.name);
}

function optionValues(options: unknown): string[] {
  return Array.isArray(options)
    ? options
        .map((o) => (typeof o === "string" ? o : (o as { promptValue?: unknown })?.promptValue))
        .filter((v): v is string => typeof v === "string")
    : [];
}

/** The value as it may enter the prompt, or why it may not. */
function fit(v: Declared, raw: string): { value: string } | { error: string } {
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
      return raw === "true" || raw === "false" ? { value: raw } : bad;
    default: {
      const value = raw.replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim();
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
  if (isPublicText(row)) return { ok: true, paid: false };

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
    const r = fit(v, raw);
    if ("error" in r) return { ok: false, status: 400, error: r.error };
    fitted.set(v.name, r.value);
  }
  return { ok: true, paid: true, variables, values: fitted };
}

/** Fill a paid prompt's [slots] with the checked values; other slots stay as written. */
export function composeAgentPrompt(text: string, inputs: Extract<AgentInputs, { paid: true }>): string {
  return text.replace(/\[([^\]\n]+)\]/g, (slot, name: string) => {
    const v = variableFor(inputs.variables, name);
    return (v && inputs.values.get(v.name)) ?? slot;
  });
}
