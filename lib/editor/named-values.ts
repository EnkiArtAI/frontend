import { varNames } from "./prompt-tokens";

/**
 * A bracket's content is the variable's name and, until the artist writes
 * one, its example value too (Kev, 2026-10-13: a pasted "[subject] at dawn"
 * fills name AND value with "subject"). Only a name the doc does not know
 * yet is filled: a value the artist set, or cleared, stays as it is. The
 * unnamed "[]" of "+ Add variable" gets nothing.
 */
export function namedValues(prompt: string, vars: Record<string, string>): Record<string, string> {
  const fresh = varNames(prompt).filter((n) => n && !(n in vars));
  return fresh.length ? { ...vars, ...Object.fromEntries(fresh.map((n) => [n, n])) } : vars;
}
