import { describe, expect, it } from "vitest";
import { namedValues } from "../named-values";
import { editorReducer, initialEditor } from "@/components/prompt-editor/usePromptEditor";

/** A bracket's content is the variable's name AND its example value, until the artist writes one (Kev, 2026-10-13). */
describe("namedValues", () => {
  it("fills every bracket the doc does not know yet with its own content", () => {
    expect(namedValues("A [subject] at [time of day]", {})).toEqual({ subject: "subject", "time of day": "time of day" });
  });

  it("leaves a value the artist set, or cleared, alone", () => {
    const vars = { subject: "the captain's dog", time: "" };
    expect(namedValues("A [subject] at [time]", vars)).toBe(vars);
  });

  it("gives the unnamed bracket of + Add variable nothing, and a text without brackets its vars back untouched", () => {
    const vars = { subject: "x" };
    expect(namedValues("A [subject] and []", vars)).toBe(vars);
    expect(namedValues("plain", vars)).toBe(vars);
  });
});

describe("in the editor", () => {
  const typed = (prompt: string, vars: Record<string, string> = {}) => {
    const start = initialEditor();
    const seeded = { ...start, history: { ...start.history, present: { ...start.history.present, vars } } };
    return editorReducer(seeded, { type: "commit", patch: { prompt }, at: 1 }).history.present;
  };

  it("a typed or pasted prompt fills its new variables as it lands", () => {
    expect(typed("A [subject] at [time]").vars).toEqual({ subject: "subject", time: "time" });
  });

  it("an edit elsewhere in the text keeps the values the artist already has", () => {
    expect(typed("A [subject] at [time], later", { subject: "a dog", time: "" }).vars).toEqual({ subject: "a dog", time: "" });
  });

  it("a patch that carries its own vars is filled from those, not the doc's", () => {
    const start = initialEditor();
    const doc = editorReducer(start, { type: "commit", patch: { prompt: "[a] [b]", vars: { a: "set" } }, at: 1 }).history.present;
    expect(doc.vars).toEqual({ a: "set", b: "b" });
  });
});
