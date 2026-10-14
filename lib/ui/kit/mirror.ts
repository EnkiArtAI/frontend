/** The token-coloured prompt mirror (components/kit/PromptMirror): what it prints and where its pill goes. */
import type { Token } from "@/lib/editor/prompt-tokens";

export type MirrorRun = { text: string; token?: Token; i?: number; missing?: boolean };

/**
 * The mirror's text cut at the tokens, ending in a zero-width space so a
 * trailing newline keeps its line. Every character is printed exactly once
 * and in place: a token that does not fit the text (a list one keystroke
 * behind, or an overlap) stays plain text, so the caret can never drift.
 * `missing` marks a reference whose image is not there.
 */
export function mirrorRuns(value: string, tokens: readonly Token[], missingRefs: readonly number[] = []): MirrorRun[] {
  const runs: MirrorRun[] = [];
  let at = 0;
  tokens.forEach((token, i) => {
    if (token.start < at || token.end > value.length) return;
    if (token.start > at) runs.push({ text: value.slice(at, token.start) });
    runs.push({ text: value.slice(token.start, token.end), token, i, missing: token.kind === "ref" && missingRefs.includes(token.n) });
    at = token.end;
  });
  runs.push({ text: `${value.slice(at)}\u200b` });
  return runs;
}

/** The room the "+ Variable" pill keeps from the field's right edge. */
const PILL_ROOM = 120;

/**
 * Where the "+ Variable" pill goes, from the end of the selection (`x`, and
 * `y` the top of its line, in the field's unscrolled content): 8 px to its
 * right and inside the field. Above the line with a mouse; below it on
 * touch, clear of the phone's own selection toolbar, which sits above.
 */
export function pillSpot({ x, y, scrollTop, width, lineHeight, below }: {
  x: number;
  y: number;
  scrollTop: number;
  width: number;
  lineHeight: number;
  below: boolean;
}): { left: number; top: number } {
  return {
    left: Math.max(0, Math.min(x + 8, width - PILL_ROOM)),
    top: below ? y - scrollTop + lineHeight + 8 : Math.max(-34, y - scrollTop - 36),
  };
}
