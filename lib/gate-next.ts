/**
 * Where the gate sends a visitor after a correct access code.
 *
 * The page it was opened for travels in the address as ?next=…, which anyone
 * can write into a link. Followed as it stands, "javascript:…" ran in the
 * app's own origin once the visitor had typed the code, and any other site's
 * address sent them there. Only a path on this site is followed: it starts
 * with one slash, and neither "//" nor "/\" (both read as another host).
 */
export function gateNext(next: string | null | undefined, home = "/home"): string {
  if (!next || next[0] !== "/" || next[1] === "/" || next[1] === "\\") return home;
  return next;
}
