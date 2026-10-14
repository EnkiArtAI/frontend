/**
 * Can this text selection become a [variable], and over which exact range?
 *
 * The "+ Variable" pill has a bug history (Kev, 2026-08-22: "in der
 * vergangenheit sehr verbuggt"): phantom pills on clicks into an existing
 * selection, brackets spliced into the middle of other tokens, and
 * whitespace swallowed into the variable name. The TIMING half of the cure
 * (defer 80ms, re-verify) lives with each editor's DOM; the VALIDATION half
 * is pure and lives here, shared by every prompt editor so their rules
 * cannot drift.
 */
import { storedName } from "@/lib/generation/stored-name";

export type VariableRange = { start: number; end: number; name: string };

/** The most characters a variable name holds (VariableRow's maxLength). */
export const NAME_MAX = 60;

const REF_NAME = /^Reference image \d+$/i;

/**
 * The name the "+ Variable" pill gives the selected words (Kev, 2026-10-13:
 * "just input an example variable name"): the selection itself, one space
 * between words, cut to NAME_MAX, and numbered (" 2", " 3"…) while another
 * variable has that name or would be saved under it (storedName), or it
 * would read as a reference. The row shows it red until it is changed.
 */
export function suggestedName(selection: string, taken: readonly string[]): string {
  const base = selection.trim().replace(/\s+/g, " ").slice(0, NAME_MAX).trim() || "variable";
  const clash = (n: string) => {
    const stored = storedName(n);
    return REF_NAME.test(n) || taken.some((t) => t === n || (stored !== null && storedName(t) === stored));
  };
  if (!clash(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`;
    const n = base.slice(0, NAME_MAX - suffix.length).trimEnd() + suffix;
    if (!clash(n)) return n;
  }
}

/** Source of the [token] pattern — NodeCreator's TOKEN_RE is built on it. */
export const TOKEN_SRC = "\\[[^\\]\\n]+\\]";

export function variableRange(value: string, start: number, end: number): VariableRange | null {
  if (start < 0 || end > value.length || end <= start) return null;
  const raw = value.slice(start, end);
  // Nothing but whitespace, spanning lines, or touching bracket characters —
  // wrapping any of those writes a token that does not parse.
  if (!raw.trim() || /[[\]\n]/.test(raw)) return null;
  // A selection overlapping an EXISTING token must never become a variable:
  // splicing brackets into a token corrupts the rename heuristic.
  const re = new RegExp(TOKEN_SRC, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    if (start < m.index + m[0].length && end > m.index) return null;
  }
  // Boundary whitespace stays in the text, not in the variable name.
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  const s2 = start + lead, e2 = end - trail;
  const name = value.slice(s2, e2);
  return name ? { start: s2, end: e2, name } : null;
}
