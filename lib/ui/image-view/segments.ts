/**
 * A free prompt's text as the Image View shows it: plain text, the [slots] a
 * buyer fills, and the "Reference image n" phrases that point at the buyer's
 * own images. The grammar is the editor's (lib/editor/prompt-tokens) read the
 * way a saved text is written: references bare, and [ ] plain text, as the
 * server fills it.
 */
import { parseTokens } from "@/lib/editor/prompt-tokens";
import { storedName } from "@/lib/generation/stored-name";

/** A stored variable, as GET /api/prompts/[id] sends it in promptData.variables. */
export interface PromptVariable {
  id: string;
  /** The stored name (a slug, app/api/prompt toDbVarName): the key its value travels under. */
  name: string;
  label: string | null;
  description: string;
  /** text | checkbox | single-select | multi-select | radio | slider | image (or a stored type no editor writes, read as text). */
  type: string;
  defaultValue: unknown;
  required: boolean;
  position: number;
  min: number | null;
  max: number | null;
  options: { promptValue: string; visibleName: string }[] | null;
}

export type Segment =
  | { kind: "text"; text: string }
  /** `name` is the slot's trimmed text; `key` is where its value lives: the variable's stored name, else `name` (a slot the buyer typed). */
  | { kind: "var"; text: string; name: string; key: string; variable?: PromptVariable }
  | { kind: "ref"; text: string; n: number };

/**
 * The variable a slot means: the one of that exact name, else the one stored
 * under the slot's stored name ("Character Design" is character_design), else
 * the one labelled with it, the only way back to a slot stored as var_N ("[猫]").
 */
export function matchVariable(variables: PromptVariable[], slot: string): PromptVariable | undefined {
  const stored = storedName(slot);
  return (
    variables.find((v) => v.name === slot) ??
    (stored ? variables.find((v) => v.name === stored) : undefined) ??
    variables.find((v) => v.label?.trim() === slot)
  );
}

/** The text cut into segments, in order; their `text` joined is the input again. */
export function parseSegments(text: string, variables: PromptVariable[]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const t of parseTokens(text, { refs: "plain" })) {
    if (t.start > at) out.push({ kind: "text", text: text.slice(at, t.start) });
    const src = text.slice(t.start, t.end);
    if (t.kind === "ref") out.push({ kind: "ref", text: src, n: t.n });
    else {
      const variable = matchVariable(variables, t.name);
      out.push({ kind: "var", text: src, name: t.name, key: variable?.name ?? t.name, variable });
    }
    at = t.end;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}
