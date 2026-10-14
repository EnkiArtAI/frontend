/** Buyer variable fields (components/kit/VariableField) and the value rows the viewers show (ValueList). */

export interface VariableOption {
  promptValue: string;
  visibleName: string;
}

/** A variable as /api/prompts/[id] answers it (app/api/prompts/[id]/route.ts). */
export interface PromptVariable {
  id: string;
  name: string;
  label: string | null;
  description: string;
  /** text, checkbox, single-select, radio, multi-select or slider; reference_image arrives as "image". */
  type: string;
  defaultValue: string | number | boolean | string[] | null;
  required: boolean;
  position: number;
  min: number | null;
  max: number | null;
  options: VariableOption[] | null;
}

export type FieldKind = "text" | "check" | "choice" | "multi" | "slider";

/**
 * How a variable is asked for. A reference-image variable takes no value
 * and gets no field; a choice without options, or a type this build does
 * not know, is asked as text, so no variable is left without a way to fill it.
 */
export function fieldKind(v: Pick<PromptVariable, "type" | "options">): FieldKind | null {
  if (v.type === "image") return null;
  if (v.type === "checkbox") return "check";
  if (v.type === "slider") return "slider";
  const listed = !!v.options?.length;
  if (listed && (v.type === "single-select" || v.type === "radio")) return "choice";
  if (listed && v.type === "multi-select") return "multi";
  return "text";
}

/** Up to five choices show as pills; more open as a menu. */
export const choiceAsPills = (count: number) => count <= 5;

/** A multi-select's chosen promptValues: its value is them comma-joined (what the buyer page sends). */
export const multiValues = (value: string) => value.split(",").filter(Boolean);

/** A multi-select's value after a tap on `key`, in option order. */
export function toggleMulti(value: string, key: string, options: readonly VariableOption[]): string {
  const chosen = new Set(multiValues(value));
  if (!chosen.delete(key)) chosen.add(key);
  return options.map((o) => o.promptValue).filter((p) => chosen.has(p)).join(",");
}

/** A slider's range, 0 to 100 unless the creator set one, and its value held inside it (the low end when there is none). */
export function sliderRange(v: Pick<PromptVariable, "min" | "max">, value: string): { min: number; max: number; value: number } {
  const min = v.min ?? 0;
  const max = v.max ?? 100;
  const n = value.trim() === "" ? NaN : Number(value);
  return { min, max, value: Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min };
}

/** A value row as shown: a dash when empty; a checkbox's text behind its box. */
export const valueText = ({ value, checked }: { value: string; checked?: boolean }) =>
  `${checked === undefined ? "" : checked ? "☑ " : "☐ "}${value || "—"}`;
