import { describe, it, expect } from "vitest";
import { parseTokens } from "@/lib/editor/prompt-tokens";
import { mirrorRuns, pillSpot } from "../mirror";

const ZWSP = "\u200b";
const joined = (runs: { text: string }[]) => runs.map((r) => r.text).join("");

describe("the mirror's runs", () => {
  it("print every character once and in place, ending in a zero-width space", () => {
    for (const v of ["a [subject] in [Reference image 1] light\n", "[]", "plain", "", "[a] [b]"]) {
      expect(joined(mirrorRuns(v, parseTokens(v)))).toBe(v + ZWSP);
    }
  });

  it("cut a token out as its own run, with its index in the list", () => {
    const v = "a [cat] by [Reference image 2]";
    const runs = mirrorRuns(v, parseTokens(v));
    expect(runs.map((r) => [r.text, r.token?.kind, r.i])).toEqual([
      ["a ", undefined, undefined],
      ["[cat]", "var", 0],
      [" by ", undefined, undefined],
      ["[Reference image 2]", "ref", 1],
      [ZWSP, undefined, undefined],
    ]);
    // Tokens side by side leave no empty run between them.
    expect(mirrorRuns("[a][b]", parseTokens("[a][b]")).map((r) => r.text)).toEqual(["[a]", "[b]", ZWSP]);
  });

  it("mark a reference missing only when its number is listed, never a variable", () => {
    const v = "[Reference image 1] [Reference image 2] [x]";
    const runs = mirrorRuns(v, parseTokens(v), [2]).filter((r) => r.token);
    expect(runs.map((r) => r.missing)).toEqual([false, true, false]);
    expect(mirrorRuns(v, parseTokens(v)).filter((r) => r.token).map((r) => r.missing)).toEqual([false, false, false]);
  });

  it("leave a token that no longer fits the text as plain text", () => {
    // The list is one keystroke behind: the text lost its last characters.
    const stale = parseTokens("go [cat]");
    const runs = mirrorRuns("go [ca", stale);
    expect(runs).toEqual([{ text: `go [ca${ZWSP}` }]);
    // Overlapping tokens never print a character twice.
    const t = parseTokens("[ab]")[0];
    const twice = mirrorRuns("[ab]", [t, { ...t, start: 1 }]);
    expect(joined(twice)).toBe(`[ab]${ZWSP}`);
    expect(twice.filter((r) => r.token)).toHaveLength(1);
  });
});

describe("the + Variable pill", () => {
  const at = { x: 100, y: 60, scrollTop: 20, width: 400, lineHeight: 24 };

  it("sits 8 px right of the selection end, inside the field", () => {
    expect(pillSpot({ ...at, below: false }).left).toBe(108);
    expect(pillSpot({ ...at, x: 390, below: false }).left).toBe(280);
    expect(pillSpot({ ...at, x: 10, width: 100, below: false }).left).toBe(0);
  });

  it("sits above the line with a mouse, never more than 34 px above the field", () => {
    expect(pillSpot({ ...at, below: false }).top).toBe(4);
    expect(pillSpot({ ...at, y: 10, below: false }).top).toBe(-34);
  });

  it("sits below the line on touch, clear of the phone's selection toolbar", () => {
    expect(pillSpot({ ...at, below: true }).top).toBe(72);
  });
});
