import { describe, it, expect } from "vitest";
import {
  parseTokens,
  varNames,
  toServerText,
  fromServerText,
  fillPrompt,
  insertToken,
  snapIndex,
  removeRef,
  renameVar,
  removeVar,
  unbracket,
} from "../prompt-tokens";

const R1 = "[Reference image 1]";

describe("parseTokens", () => {
  it("reads variables, references and the unnamed variable, and never a token across a newline", () => {
    const text = `a [x] ${R1} [] [y\nz]`;
    expect(parseTokens(text)).toEqual([
      { kind: "var", start: 2, end: 5, name: "x" },
      { kind: "ref", start: 6, end: 25, name: "Reference image 1", n: 1 },
      { kind: "blank", start: 26, end: 28, name: "" },
    ]);
    expect(parseTokens("[a\nb]")).toEqual([]);
  });

  it("knows a reference in any case, and [Character n] is a plain variable", () => {
    expect(parseTokens("[reference IMAGE 12]")).toEqual([{ kind: "ref", start: 0, end: 20, name: "reference IMAGE 12", n: 12 }]);
    expect(parseTokens("[Character 1]")).toEqual([{ kind: "var", start: 0, end: 13, name: "Character 1" }]);
  });

  it("leaves a bare phrase alone in the editor", () => {
    expect(parseTokens("use Reference image 2 here")).toEqual([]);
  });

  it("reads a saved text the server's way: bare phrases are references, [ ] is text, names are trimmed", () => {
    const text = `Reference image 2 and ${R1} [ ] [] [ cat ]`;
    expect(parseTokens(text, { refs: "plain" })).toEqual([
      { kind: "ref", start: 0, end: 17, name: "Reference image 2", n: 2 },
      { kind: "var", start: 22, end: 41, name: "Reference image 1" },
      { kind: "var", start: 49, end: 56, name: "cat" },
    ]);
  });
});

describe("varNames", () => {
  it("is unique, in order of first appearance, with the unnamed one and without references", () => {
    expect(varNames(`[b] [a] [b] [] [reference image 3] ${R1} [a]`)).toEqual(["b", "a", ""]);
  });

  it("reads a saved text with trimmed names", () => {
    expect(varNames("[ cat ] [cat] [Reference image 1]", { refs: "plain" })).toEqual(["cat", "Reference image 1"]);
  });
});

describe("toServerText / fromServerText", () => {
  it("drops only the references' brackets", () => {
    expect(toServerText(`a ${R1} [b] [reference image 2]`)).toBe("a Reference image 1 [b] reference image 2");
  });

  it("brackets a stored reference again only when that image exists", () => {
    expect(fromServerText("Reference image 1, reference image 2, Reference image 3", 2)).toBe(
      "[Reference image 1], [reference image 2], Reference image 3",
    );
    expect(fromServerText("Reference image 0", 2)).toBe("Reference image 0");
  });

  it("never touches a reference phrase inside a variable", () => {
    expect(fromServerText("[pose of Reference image 1]", 1)).toBe("[pose of Reference image 1]");
  });

  it("round-trips", () => {
    const prompt = `[subject] beside ${R1}, lit like [Reference image 2]`;
    expect(fromServerText(toServerText(prompt), 2)).toBe(prompt);
    const stored = "a [b] Reference image 1 c";
    expect(toServerText(fromServerText(stored, 1))).toBe(stored);
  });
});

describe("fillPrompt", () => {
  it("sends references as text and every variable as its value, the unnamed one included", () => {
    expect(fillPrompt(`[] [mood] cat, ${R1}`, { "": "a", mood: "calm" })).toBe("a calm cat, Reference image 1");
  });

  it("expands references before variables: a value is sent as written", () => {
    expect(fillPrompt("[x] and [y]", { x: R1, y: "[Reference image 2]" })).toBe(`${R1} and [Reference image 2]`);
  });

  it("puts a checkbox's text in, as if ticked, and nothing for a variable without a value", () => {
    expect(fillPrompt("a cat [glow] [none] [constructor]", { glow: "with a soft glow" })).toBe("a cat with a soft glow  ");
  });
});

describe("insertToken", () => {
  const T = "[Reference image 1]";
  it("spaces a token from its neighbours", () => {
    expect(insertToken("", 0, T)).toEqual({ text: T, caret: 19 });
    expect(insertToken("cat", 0, T)).toEqual({ text: `${T} cat`, caret: 19 });
    expect(insertToken("cat dog", 3, T)).toEqual({ text: `cat ${T} dog`, caret: 23 });
    expect(insertToken("cat", 3, T)).toEqual({ text: `cat ${T}`, caret: 23 });
  });

  it("adds no space after whitespace, a newline, or before punctuation", () => {
    expect(insertToken("cat \ndog", 5, T).text).toBe(`cat \n${T} dog`);
    expect(insertToken("cat ", 4, T).text).toBe(`cat ${T}`);
    for (const p of [")", ",", ".", ";", ":", "!", "?"]) expect(insertToken(`cat${p}`, 3, T).text).toBe(`cat ${T}${p}`);
  });

  it("never lands inside another token", () => {
    expect(insertToken("[mood] x", 2, T)).toEqual({ text: `${T} [mood] x`, caret: 19 });
    expect(insertToken("[mood] x", 4, T).text).toBe(`[mood] ${T} x`);
  });
});

describe("snapIndex", () => {
  const text = "a [mood] bright day";
  const mood = { start: 2, end: 8 };
  it("moves an index inside a token to its nearer edge", () => {
    expect(snapIndex(text, 4)).toBe(2);
    expect(snapIndex(text, 6)).toBe(8);
    expect(snapIndex(text, 5)).toBe(8);
    expect(snapIndex("[] x", 1)).toBe(2);
  });

  it("is null inside or at the edges of the dragged token", () => {
    for (let i = mood.start; i <= mood.end; i++) expect(snapIndex(text, i, mood), "index " + i).toBeNull();
    expect(snapIndex(text, 1, mood)).toBe(1);
  });

  it("moves an index inside a word to the nearer boundary, and keeps one between words", () => {
    expect(snapIndex(text, 11)).toBe(9);
    expect(snapIndex(text, 13)).toBe(15);
    expect(snapIndex(text, 12)).toBe(9);
    expect(snapIndex(text, 15)).toBe(15);
    expect(snapIndex("[x]ab", 4)).toBe(3);
  });
});

describe("removeRef", () => {
  it("removes every use of the reference with one adjacent space and renumbers only higher ones", () => {
    expect(removeRef(`a ${R1} b [reference image 3] [Reference image 2] ${R1}`, 2)).toBe(`a ${R1} b [reference image 2] ${R1}`);
  });

  it("takes the space before, else the one after, and nothing else", () => {
    expect(removeRef(`a ${R1}.`, 1)).toBe("a.");
    expect(removeRef(`${R1} a`, 1)).toBe("a");
    expect(removeRef(`a\n${R1}  b`, 1)).toBe("a\n b");
    expect(removeRef(`${R1} ${R1} x`, 1)).toBe("x");
    expect(removeRef(`x  y\n\n${R1}`, 1)).toBe("x  y\n\n");
  });
});

describe("renameVar", () => {
  it("rewrites every [old], and nothing else", () => {
    expect(renameVar(`[cat] and [cat] with [cats] ${R1}`, "cat", "dog")).toEqual({ ok: true, text: `[dog] and [dog] with [cats] ${R1}` });
    expect(renameVar("[] x []", "", "hero")).toEqual({ ok: true, text: "[hero] x [hero]" });
  });

  it("refuses a name another variable is saved under, exact or by stored name", () => {
    expect(renameVar("[Cat] [x]", "x", "cat")).toEqual({ ok: false, reason: "taken", other: "Cat" });
    expect(renameVar("[red car] [x]", "x", "red-car")).toEqual({ ok: false, reason: "taken", other: "red car" });
    expect(renameVar("[2nd] [x]", "x", "v 2nd")).toEqual({ ok: false, reason: "taken", other: "2nd" });
    expect(renameVar("[] [x]", "x", "")).toEqual({ ok: false, reason: "taken", other: "" });
    expect(renameVar("[名前] [x]", "x", "名前")).toEqual({ ok: false, reason: "taken", other: "名前" });
  });

  it("lets a variable keep its own stored name, and two names without one apart", () => {
    expect(renameVar("[Cat] [cat]", "Cat", "CAT")).toEqual({ ok: false, reason: "taken", other: "cat" });
    expect(renameVar("[Cat] [x]", "Cat", "cat")).toEqual({ ok: true, text: "[cat] [x]" });
    expect(renameVar("[日本] [x]", "x", "名前")).toEqual({ ok: true, text: "[日本] [名前]" });
  });

  it("reserves references, allows [Character n], and refuses brackets and newlines", () => {
    expect(renameVar("[x]", "x", "Reference image 2")).toEqual({ ok: false, reason: "reserved" });
    expect(renameVar("[x]", "x", "reference image 2")).toEqual({ ok: false, reason: "reserved" });
    expect(renameVar("[x]", "x", "Character 1")).toEqual({ ok: true, text: "[Character 1]" });
    for (const bad of ["a]b", "a[b", "a\nb"]) expect(renameVar("[x]", "x", bad)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("removeVar", () => {
  it("writes the value in, else the name", () => {
    expect(removeVar("a [mood] cat, [mood]", "mood", "calm")).toBe("a calm cat, calm");
    expect(removeVar("a [mood] cat [x]", "mood", "")).toBe("a mood cat [x]");
  });

  it("leaves nothing for an empty unnamed variable, with one space", () => {
    expect(removeVar("a [] b []", "", "")).toBe("a b");
    expect(removeVar("a [] b", "", "big")).toBe("a big b");
  });
});

describe("unbracket", () => {
  const text = "a [red] fox at [dusk]";

  it("a deleted ] takes the token's [ with it, and the caret moves back by one", () => {
    // Backspace on the "]" of [red]: caret 6, the "[" at 2 goes too.
    expect(unbracket(text, "a [red fox at [dusk]", 6)).toEqual({ text: "a red fox at [dusk]", caret: 5 });
    // Delete on the last token's "]" (caret 20): its "[" at 15 goes.
    expect(unbracket(text, "a [red] fox at [dusk", 20)).toEqual({ text: "a [red] fox at dusk", caret: 19 });
  });

  it("a deleted [ takes the token's ] with it, and the caret stays", () => {
    expect(unbracket(text, "a red] fox at [dusk]", 2)).toEqual({ text: "a red fox at [dusk]", caret: 2 });
    expect(unbracket("[] b", " b", 0)).toBeNull(); // two characters gone: not a single deletion
    expect(unbracket("[] b", "] b", 0)).toEqual({ text: " b", caret: 0 });
  });

  it("stands aside for every other edit: typing, deleting a letter, a bracket outside any token, a selection", () => {
    expect(unbracket(text, "a [red] fox at [dusk]!", 22)).toBeNull();
    expect(unbracket(text, "a [rd] fox at [dusk]", 4)).toBeNull();
    expect(unbracket("a ] b", "a  b", 2)).toBeNull();
    expect(unbracket("a [x b", "a x b", 2)).toBeNull();
    expect(unbracket(text, "a fox at [dusk]", 2)).toBeNull();
    expect(unbracket(text, text, 3)).toBeNull();
  });

  it("a reference token loses both brackets too", () => {
    expect(unbracket("see [Reference image 1] now", "see [Reference image 1 now", 22)).toEqual({ text: "see Reference image 1 now", caret: 21 });
  });
});
