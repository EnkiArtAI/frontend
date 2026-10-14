import { describe, it, expect } from "vitest";
import { startHistory, commit, undo, redo, type EditorDoc, type History } from "../undo";

const doc = (prompt: string, o: Partial<EditorDoc> = {}): EditorDoc => ({ prompt, vars: {}, kinds: {}, aiNames: [], refIds: [], ...o });
const prompts = (docs: EditorDoc[]) => docs.map((d) => d.prompt);

describe("commit", () => {
  it("folds commits under one key at most 900 ms apart into one step", () => {
    let h = startHistory(doc(""));
    h = commit(h, { prompt: "a" }, 1000, "prompt");
    h = commit(h, { prompt: "ab" }, 1900, "prompt");
    expect(prompts(h.past)).toEqual([""]);
    expect(h.present.prompt).toBe("ab");
    h = commit(h, { prompt: "abc" }, 2801, "prompt");
    expect(prompts(h.past)).toEqual(["", "ab"]);
  });

  it("makes a new step for another key, and for every commit without one", () => {
    let h = startHistory(doc(""));
    h = commit(h, { prompt: "a" }, 1000, "prompt");
    h = commit(h, { vars: { x: "1" } }, 1001, "var:x");
    h = commit(h, { aiNames: ["x"] }, 1002);
    h = commit(h, { aiNames: [] }, 1003);
    expect(h.past).toHaveLength(4);
    expect(h.present).toEqual(doc("a", { vars: { x: "1" } }));
  });

  it("keeps 60 steps and drops the oldest", () => {
    let h = startHistory(doc("0"));
    for (let i = 1; i <= 61; i++) h = commit(h, { prompt: String(i) }, i * 1000);
    expect(h.past).toHaveLength(60);
    expect(h.past[0].prompt).toBe("1");
    expect(h.present.prompt).toBe("61");
  });

  it("drops the redo steps", () => {
    let h = commit(startHistory(doc("")), { prompt: "a" }, 0);
    h = undo(h);
    expect(h.future).toHaveLength(1);
    expect(commit(h, { prompt: "b" }, 5000).future).toEqual([]);
  });
});

describe("undo and redo", () => {
  it("give back the whole doc, the ✦ AI marks included (R20)", () => {
    let h = startHistory(doc("[mood]", { vars: { mood: "" } }));
    h = commit(h, { vars: { mood: "calm" }, aiNames: ["mood"] }, 1000); // Vary
    h = commit(h, { vars: { mood: "calmer" }, aiNames: [] }, 2000, "var:mood"); // typing clears the mark
    h = undo(h);
    expect(h.present).toEqual(doc("[mood]", { vars: { mood: "calm" }, aiNames: ["mood"] }));
    h = undo(h);
    expect(h.present.aiNames).toEqual([]);
    h = redo(h);
    expect(h.present).toEqual(doc("[mood]", { vars: { mood: "calm" }, aiNames: ["mood"] }));
    h = redo(h);
    expect(h.present).toEqual(doc("[mood]", { vars: { mood: "calmer" } }));
  });

  it("do nothing at either end", () => {
    const h: History = startHistory(doc("a"));
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it("never let the next keystroke fold into what came back", () => {
    let h = startHistory(doc(""));
    h = commit(h, { prompt: "a" }, 1000, "prompt");
    h = undo(h);
    h = commit(h, { prompt: "b" }, 1100, "prompt");
    expect(prompts(h.past)).toEqual([""]);
    h = commit(startHistory(doc("")), { prompt: "a" }, 1000, "prompt");
    h = redo(undo(h));
    h = commit(h, { prompt: "ab" }, 1100, "prompt");
    expect(prompts(h.past)).toEqual(["", "a"]);
  });
});
