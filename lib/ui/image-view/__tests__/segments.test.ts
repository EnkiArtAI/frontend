import { describe, it, expect } from "vitest";
import { matchVariable, parseSegments, type PromptVariable } from "../segments";

const variable = (name: string, over: Partial<PromptVariable> = {}): PromptVariable => ({
  id: name, name, label: null, description: "", type: "text", defaultValue: null,
  required: false, position: 0, min: null, max: null, options: null, ...over,
});

describe("matchVariable", () => {
  it("takes the variable of that exact name first (a legacy name the slug rule would change)", () => {
    const mood = variable("mood_");
    expect(matchVariable([variable("mood"), mood], "mood_")).toBe(mood);
  });

  it("then the one stored under the slot's stored name", () => {
    const design = variable("character_design");
    expect(matchVariable([design], "Character Design")).toBe(design);
    const second = variable("v_2nd_subject");
    expect(matchVariable([second], "2nd subject")).toBe(second);
  });

  it("then the one labelled with it: the only way back to a slot stored as var_N", () => {
    const cat = variable("var_1", { label: " 猫 " });
    expect(matchVariable([variable("dog"), cat], "猫")).toBe(cat);
  });

  it("prefers the stored name over a label", () => {
    const byName = variable("cat", { label: "Kitty" });
    const byLabel = variable("dog", { label: "Cat" });
    expect(matchVariable([byLabel, byName], "Cat")).toBe(byName);
  });

  it("finds nothing for a slot no variable answers to", () => {
    expect(matchVariable([variable("cat", { label: "Cat" })], "sky")).toBeUndefined();
  });
});

describe("parseSegments", () => {
  const subject = variable("subject");
  const mood = variable("mood");

  it("cuts text, slots and references, and joins back to the text", () => {
    const text = "A [Subject] in [ mood ], like Reference image 2.";
    const segs = parseSegments(text, [subject, mood]);
    expect(segs).toEqual([
      { kind: "text", text: "A " },
      { kind: "var", text: "[Subject]", name: "Subject", key: "subject", variable: subject },
      { kind: "text", text: " in " },
      { kind: "var", text: "[ mood ]", name: "mood", key: "mood", variable: mood },
      { kind: "text", text: ", like " },
      { kind: "ref", text: "Reference image 2", n: 2 },
      { kind: "text", text: "." },
    ]);
    expect(segs.map((s) => s.text).join("")).toBe(text);
  });

  it("keeps [ ] and [] as text", () => {
    expect(parseSegments("a [ ] b [] c", [subject])).toEqual([{ kind: "text", text: "a [ ] b [] c" }]);
  });

  it("reads a bracketed reference as a slot, never a reference (a saved text keeps references bare)", () => {
    expect(parseSegments("[Reference image 2]", [])).toEqual([
      { kind: "var", text: "[Reference image 2]", name: "Reference image 2", key: "Reference image 2", variable: undefined },
    ]);
  });

  it("keys a slot the buyer typed by its own trimmed text", () => {
    expect(parseSegments("[ sky ]", [subject])).toEqual([{ kind: "var", text: "[ sky ]", name: "sky", key: "sky", variable: undefined }]);
  });

  it("gives nothing for an empty text", () => {
    expect(parseSegments("", [subject])).toEqual([]);
  });
});
