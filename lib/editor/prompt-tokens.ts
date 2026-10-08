/**
 * The one prompt grammar the editor, the Image View and the blank composer
 * share (plan §1.2), so a token can never mean two things on two screens.
 *
 *   [name]               a variable; [] is the one unnamed variable
 *   [Reference image n]  the n-th reference, as the editor writes it ("bracketed")
 *   Reference image n    the same reference in a saved text ("plain"): the server
 *                        reads every [..] as a slot, so it stores them bare
 *
 * A token never spans a newline. [Character n] means nothing special: it is a
 * variable called "Character n" (plan R19).
 */
import { storedName } from "@/lib/generation/stored-name";

export type Token =
  | { kind: "var" | "blank"; start: number; end: number; name: string }
  | { kind: "ref"; start: number; end: number; name: string; n: number };

export type RefStyle = "bracketed" | "plain";

const TOKEN = /\[([^\]\n]*)\]|\bReference image (\d+)\b/gi;
const REF = /^Reference image (\d+)$/i;

/** Every token in order. `start`/`end` cover the brackets; `name` is the text between them. */
export function parseTokens(text: string, { refs = "bracketed" }: { refs?: RefStyle } = {}): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index;
    const end = start + m[0].length;
    const inner = m[1];
    if (inner === undefined) {
      // A bare phrase is a reference only in a saved text.
      if (refs === "plain") out.push({ kind: "ref", start, end, name: m[0], n: Number(m[2]) });
    } else if (refs === "plain") {
      // A buyer's slots read as the server fills them: trimmed, and [ ] is text.
      const name = inner.trim();
      if (name) out.push({ kind: "var", start, end, name });
    } else {
      const ref = REF.exec(inner);
      out.push(ref ? { kind: "ref", start, end, name: inner, n: Number(ref[1]) } : { kind: inner ? "var" : "blank", start, end, name: inner });
    }
  }
  return out;
}

/** The variable names, unnamed included, unique, in order of first appearance. */
export function varNames(text: string, opts?: { refs?: RefStyle }): string[] {
  return [...new Set(parseTokens(text, opts).filter((t) => t.kind !== "ref").map((t) => t.name))];
}

/**
 * Rebuild `text` token by token: a string replaces the token, null removes it
 * together with ONE adjacent space (the one before it, else the one after),
 * undefined keeps it. Nothing else in the text changes (plan R18).
 */
function rewrite(text: string, tokens: Token[], edit: (t: Token) => string | null | undefined): string {
  let out = "";
  let at = 0;
  for (const t of tokens) {
    const r = edit(t);
    if (r === undefined) continue;
    let { start, end } = t;
    if (r === null) {
      if (start > at && text[start - 1] === " ") start--;
      else if (text[end] === " ") end++;
    }
    out += text.slice(at, start) + (r ?? "");
    at = end;
  }
  return out + text.slice(at);
}

/** What the server stores: references lose their brackets, variables keep theirs. */
export const toServerText = (prompt: string) =>
  rewrite(prompt, parseTokens(prompt), (t) => (t.kind === "ref" ? t.name : undefined));

/** A stored text back in the editor: "Reference image n" is a token again, for the references that exist. */
export const fromServerText = (content: string, refCount: number) =>
  rewrite(content, parseTokens(content, { refs: "plain" }), (t) =>
    t.kind === "ref" && t.n >= 1 && t.n <= refCount ? `[${t.name}]` : undefined,
  );

/**
 * The text a test render sends: references as plain text, every variable as
 * its value (a checkbox's value is the text it adds when ticked). One pass, so
 * a value that contains "[Reference image 1]" is sent as written.
 */
export const fillPrompt = (prompt: string, vars: Record<string, string>) =>
  rewrite(prompt, parseTokens(prompt), (t) => (t.kind === "ref" ? t.name : Object.hasOwn(vars, t.name) ? vars[t.name] : ""));

/** An index inside a token moves to that token's nearer edge. */
function outside(text: string, i: number): number {
  const t = parseTokens(text).find((k) => i > k.start && i < k.end);
  return !t ? i : i - t.start < t.end - i ? t.start : t.end;
}

/**
 * Put `token` at the caret, never inside another token, with a space on each
 * side unless that neighbour is whitespace or, on the right, punctuation.
 */
export function insertToken(text: string, at: number, token: string): { text: string; caret: number } {
  const i = outside(text, at);
  const before = text.slice(0, i);
  const after = text.slice(i);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^[\s),.;:!?]/.test(after) ? " " : "";
  return { text: before + lead + token + trail + after, caret: i + lead.length + token.length };
}

/**
 * Where a drop at `i` lands: out of any token to its nearer edge, out of a
 * word to its nearer boundary, and null on the dragged token itself (a drop
 * there moves nothing). Pass the result to moveToken.
 */
export function snapIndex(text: string, i: number, dragged?: { start: number; end: number }): number | null {
  let j = outside(text, i);
  const word = (c: string | undefined) => c !== undefined && !/[\s[\]]/.test(c);
  if (j === i && word(text[i - 1]) && word(text[i])) {
    let l = i;
    let r = i;
    while (word(text[l - 1])) l--;
    while (word(text[r])) r++;
    j = i - l <= r - i ? l : r;
  }
  return dragged && j >= dragged.start && j <= dragged.end ? null : j;
}

/** Remove reference n: each [Reference image n] goes with one adjacent space, and every higher one moves down by one. */
export const removeRef = (text: string, n: number) =>
  rewrite(text, parseTokens(text), (t) =>
    t.kind !== "ref" || t.n < n ? undefined : t.n === n ? null : `[${t.name.replace(/\d+$/, String(t.n - 1))}]`,
  );

export type Rename = { ok: true; text: string } | { ok: false; reason: "invalid" | "reserved" | "taken"; other?: string };

/**
 * Rename every [from] to [to] (plan R19). Refused when `to` holds a bracket or
 * a newline, when it names a reference, and when another variable has that
 * name or the same stored name: the save route would store the two as one and
 * refuse the prompt (app/api/prompt "Two variables would be saved under one name").
 */
export function renameVar(text: string, from: string, to: string): Rename {
  if (/[[\]\n]/.test(to)) return { ok: false, reason: "invalid" };
  if (REF.test(to)) return { ok: false, reason: "reserved" };
  const stored = storedName(to);
  const other = varNames(text).find((n) => n !== from && (n === to || (stored !== null && storedName(n) === stored)));
  if (other !== undefined) return { ok: false, reason: "taken", other };
  return { ok: true, text: rewrite(text, parseTokens(text), (t) => (t.name === from ? `[${to}]` : undefined)) };
}

/** Take a variable out of the text: each [name] becomes its value, else its name; an empty unnamed one leaves nothing. */
export const removeVar = (text: string, name: string, value: string) =>
  rewrite(text, parseTokens(text), (t) => (t.name !== name ? undefined : value || name || null));
