import { describe, it, expect } from "vitest";
import { parseSegments, type PromptVariable } from "../segments";
import { assembleFreePrompt, buildGenerationPrompt, clipboardText, promptRefusal } from "../assemble";

const variable = (name: string, over: Partial<PromptVariable> = {}): PromptVariable => ({
  id: name, name, label: null, description: "", type: "text", defaultValue: null,
  required: false, position: 0, min: null, max: null, options: null, ...over,
});

const subject = variable("character_design", { label: "Character", position: 2 });
const rain = variable("rain", { type: "checkbox", label: "Rain", description: "in heavy rain", position: 1 });
const style = variable("style", { type: "single-select", options: [{ promptValue: "oil paint", visibleName: "Oil" }], position: 3 });
const VARS = [subject, rain, style];
const TEXT = "[Character Design] [rain], in [style] like Reference image 1 [ ] [sky]";

describe("assembleFreePrompt", () => {
  const fill = (values: Record<string, string>) => assembleFreePrompt(parseSegments(TEXT, VARS), values);

  it("writes each slot's value in, a ticked checkbox as its text, a choice as its promptValue", () => {
    expect(fill({ character_design: "a fox", rain: "true", style: "oil paint", sky: "red sky" })).toBe(
      "a fox in heavy rain, in oil paint like Reference image 1 [ ] red sky",
    );
  });

  it("an unticked checkbox adds nothing; a slot without a value keeps its brackets", () => {
    expect(fill({ character_design: " ", rain: "false", style: "" })).toBe("[Character Design] , in [style] like Reference image 1 [ ] [sky]");
  });

  it("leaves a text without slots as it is", () => {
    expect(assembleFreePrompt(parseSegments("A harbour, Reference image 2", VARS), { rain: "true" })).toBe("A harbour, Reference image 2");
  });

  describe("more images than the text names (Kev, 2026-10-13)", () => {
    const fill = (text: string, refs: number) => assembleFreePrompt(parseSegments(text, VARS), {}, refs);

    it("names the rest right after the last reference the text has, however many it has", () => {
      expect(fill("a cat like Reference image 1, at dusk", 3)).toBe("a cat like Reference image 1 Reference image 2 Reference image 3, at dusk");
      expect(fill("Reference image 2 beside Reference image 1 here", 3)).toBe("Reference image 2 beside Reference image 1 Reference image 3 here");
      expect(fill("Reference image 1", 2)).toBe("Reference image 1 Reference image 2");
      // Counted from the highest number named, not how often one is named.
      expect(fill("Reference image 1 and Reference image 1 again", 2)).toBe("Reference image 1 and Reference image 1 Reference image 2 again");
      expect(fill("a cat like Reference image 3", 3)).toBe("a cat like Reference image 3");
    });

    it("names them after the text when it names none, and adds nothing when every image is named already", () => {
      expect(fill("a cat", 2)).toBe("a cat Reference image 1 Reference image 2");
      expect(fill("", 1)).toBe("Reference image 1");
      expect(fill("a cat like Reference image 1 and Reference image 2", 2)).toBe("a cat like Reference image 1 and Reference image 2");
      expect(fill("a cat like Reference image 3", 1)).toBe("a cat like Reference image 3");
      expect(fill("a [subject]", 0)).toBe("a [subject]");
    });

    it("fills the slots in the same pass", () => {
      expect(assembleFreePrompt(parseSegments("[sky] over Reference image 1", VARS), { sky: "red sky" }, 2)).toBe("red sky over Reference image 1 Reference image 2");
    });
  });
});

describe("buildGenerationPrompt", () => {
  it("fills a free text (the edited one when there is one), naming every image that goes with it", () => {
    expect(buildGenerationPrompt({ title: "T", text: "[Character Design] at dawn", variables: VARS, values: { character_design: "a fox" } })).toBe("a fox at dawn");
    expect(buildGenerationPrompt({ text: "[Character Design] like Reference image 1", variables: VARS, values: { character_design: "a fox" }, refs: 2 })).toBe("a fox like Reference image 1 Reference image 2");
    // A premium prompt's stand-in names none: the server has the text.
    expect(buildGenerationPrompt({ title: "Harbour", text: null, variables: [], values: {}, refs: 2 })).toBe("Harbour");
  });

  it("sends the blank composer's own text with its typed slots filled, and nothing when nothing was typed", () => {
    expect(buildGenerationPrompt({ text: "a [beast] on a hill", variables: [], values: { beast: "wolf" } })).toBe("a wolf on a hill");
    expect(buildGenerationPrompt({ text: "", variables: [], values: {} })).toBe("");
  });

  it("without a text (premium) sends the title and each value that says something, by position, for the server to replace", () => {
    expect(buildGenerationPrompt({ title: "Harbour", text: null, variables: VARS, values: { rain: "true", character_design: "a fox", style: "" } })).toBe(
      "Harbour, Rain: in heavy rain, Character: a fox",
    );
    expect(buildGenerationPrompt({ text: null, variables: VARS, values: { rain: "false" } })).toBe("A beautiful artistic image");
  });
});

describe("clipboardText", () => {
  const values = { character_design: "a fox", rain: "true", style: "oil paint", sky: "red sky" };

  it("T copies the text with its slots, [ ] the text filled in: what is on screen", () => {
    expect(clipboardText({ view: "text", text: TEXT, variables: VARS, values })).toBe(TEXT);
    expect(clipboardText({ view: "filled", text: TEXT, variables: VARS, values })).toBe("a fox in heavy rain, in oil paint like Reference image 1 [ ] red sky");
  });

  it("a premium prompt copies the buyer's own values, one per line", () => {
    expect(clipboardText({ view: "filled", text: null, variables: VARS, values: { ...values, rain: "false" } })).toBe("Character: a fox\nstyle: oil paint");
  });
});

describe("promptRefusal", () => {
  it("refuses an empty text", () => {
    expect(promptRefusal(" \n ", false)).toBe("Write a prompt first");
  });

  it("refuses more than 4,000 characters, counted after trimming as the routes do", () => {
    expect(promptRefusal(`  ${"a".repeat(4000)}  `, true)).toBeNull();
    expect(promptRefusal("a".repeat(4001), false)).toBe("The prompt is 4,001 characters; 4,000 is the most that can be sent");
  });

  it("refuses more than 20 [ only for a paid generator", () => {
    expect(promptRefusal("[".repeat(20), true)).toBeNull();
    expect(promptRefusal("[".repeat(21), true)).toBe("A prompt for a paid generator can hold at most 20 [");
    expect(promptRefusal("[".repeat(21), false)).toBeNull();
  });
});
