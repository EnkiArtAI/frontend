/**
 * The buyer's values: where they start, when a field counts as filled, and
 * what each one sends. A value is always a string (a checkbox "true" or
 * "false", a multi-select its promptValues joined by commas), kept under the
 * variable's stored name, or under the slot's own text for a slot the buyer
 * typed into a free text.
 */
import type { PromptVariable, Segment } from "./segments";

/** One input of the composer. */
export interface Field {
  key: string;
  /** Its name on screen: the variable's label, else its name; a typed slot's own text. */
  label: string;
  /** Absent for a slot the buyer typed. */
  variable?: PromptVariable;
}

/** A value as the viewer lists it (kit ValueList). */
export interface ValueRow {
  name: string;
  value: string;
  checked?: boolean;
}

/** Each variable's default as a string under its stored name: true is "true", none is "". */
export function initialValues(variables: PromptVariable[]): Record<string, string> {
  return Object.fromEntries(variables.map((v) => [v.name, v.defaultValue == null ? "" : String(v.defaultValue)]));
}

/**
 * What a value sends: a ticked checkbox its text (the editor keeps it in the
 * description), an unticked one nothing, every other value as it stands.
 */
export function sendValue(v: PromptVariable | undefined, value = ""): string {
  if (v?.type !== "checkbox") return value;
  return value === "true" ? v.description || v.label || v.name : "";
}

/** Whether Generate may go without more: a checkbox always, a multi-select unless it is required, anything else (a typed slot too) once it holds more than spaces. */
export function isFilled(v: PromptVariable | undefined, value = ""): boolean {
  if (v?.type === "checkbox" || (v?.type === "multi-select" && !v.required)) return true;
  return value.trim() !== "";
}

/** Every stored variable's value as the server fills a premium text with it, by stored name. */
export function toServerValues(variables: PromptVariable[], values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(variables.map((v) => [v.name, sendValue(v, values[v.name])]));
}

const labelOf = (v: PromptVariable) => v.label || v.name;

/**
 * The composer's fields, in order: the slots of a free text (each once), or,
 * without a text (a premium prompt), every stored variable by position. An
 * image variable takes no input here.
 */
export function fieldsFor(variables: PromptVariable[], segments: Segment[] | null): Field[] {
  const fields: Field[] = [];
  if (!segments) {
    for (const v of [...variables].sort((a, b) => a.position - b.position)) fields.push({ key: v.name, label: labelOf(v), variable: v });
  } else {
    for (const s of segments) {
      if (s.kind === "var" && !fields.some((f) => f.key === s.key)) {
        fields.push({ key: s.key, label: s.variable ? labelOf(s.variable) : s.name, variable: s.variable });
      }
    }
  }
  return fields.filter((f) => f.variable?.type !== "image");
}

/** The first field Generate may not go without, for the surface to focus and say "Fill in {label} first" (plan R11); null when none. */
export function missingRequired(fields: Field[], values: Record<string, string>): Field | null {
  return fields.find((f) => !isFilled(f.variable, values[f.key])) ?? null;
}

/** The fields with their values, as a render's value list shows them: a checkbox by its text and whether it was ticked. */
export function valueRows(fields: Field[], values: Record<string, string>): ValueRow[] {
  return fields.map(({ key, label, variable }) =>
    variable?.type === "checkbox"
      ? { name: label, value: sendValue(variable, "true"), checked: values[key] === "true" }
      : { name: label, value: values[key] ?? "" },
  );
}
