/**
 * The text a render sends and the text Copy takes. A free prompt's text (and
 * the blank composer's) is the buyer's to send: the server generates from it
 * as it arrives. A premium prompt's text never reaches the client; the server
 * fills it with the buyer's values itself (app/api/generate-image), so the
 * client sends a stand-in.
 */
import { parseSegments, type PromptVariable, type Segment } from "./segments";
import { fieldsFor, isFilled, sendValue } from "./variables";

/** The longest text both routes take (generate-image, generate-free), counted after trimming as they do. */
export const PROMPT_MAX = 4000;

/** The free text filled in: each slot becomes the value it sends and keeps its [brackets] while it has none; references stay as written. */
export function assembleFreePrompt(segments: Segment[], values: Record<string, string>): string {
  return segments
    .map((s) => (s.kind === "var" && isFilled(s.variable, values[s.key]) ? sendValue(s.variable, values[s.key]) : s.text))
    .join("");
}

/** "label: value" for each stored variable that sends something, by position. */
const valueLines = (variables: PromptVariable[], values: Record<string, string>) =>
  fieldsFor(variables, null).flatMap((f) => {
    const v = sendValue(f.variable, values[f.key]);
    return v ? [`${f.label}: ${v}`] : [];
  });

/**
 * The prompt Generate sends. With a text (a free prompt, the blank composer)
 * that text filled in; without one (a premium prompt) "title, label: value, …",
 * which the server replaces with the artist's text filled with the values.
 */
export function buildGenerationPrompt({ title, text, variables, values }: {
  title?: string;
  text: string | null;
  variables: PromptVariable[];
  values: Record<string, string>;
}): string {
  if (text !== null) return assembleFreePrompt(parseSegments(text, variables), values);
  return [title || "A beautiful artistic image", ...valueLines(variables, values)].join(", ");
}

/**
 * What Copy takes: what is on screen. T ("text") shows the text with its
 * [slots], [ ] ("filled") shows it filled in, and a premium prompt has no
 * text, only the buyer's "label: value" lines.
 */
export function clipboardText({ view, text, variables, values }: {
  view: "text" | "filled";
  text: string | null;
  variables: PromptVariable[];
  values: Record<string, string>;
}): string {
  if (text === null) return valueLines(variables, values).join("\n");
  return view === "text" ? text : assembleFreePrompt(parseSegments(text, variables), values);
}

/**
 * Why a route would refuse the buyer's own text (a free prompt, the blank
 * composer), said before a wallet is asked; null when it can go. The 20
 * brackets are the paid route's rule only. A premium prompt's stand-in is not
 * checked: the server generates from the artist's text instead.
 */
export function promptRefusal(prompt: string, paid: boolean): string | null {
  const t = prompt.trim();
  if (!t) return "Write a prompt first";
  if (t.length > PROMPT_MAX) return `The prompt is ${t.length.toLocaleString("en-US")} characters; ${PROMPT_MAX.toLocaleString("en-US")} is the most that can be sent`;
  if (paid && (t.match(/\[/g)?.length ?? 0) > 20) return "A prompt for a paid generator can hold at most 20 [";
  return null;
}
