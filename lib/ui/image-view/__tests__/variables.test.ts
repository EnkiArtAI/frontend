import { describe, it, expect } from "vitest";
import { parseSegments, type PromptVariable } from "../segments";
import { fieldsFor, initialValues, isFilled, missingRequired, sendValue, toServerValues, valueRows } from "../variables";

const variable = (name: string, over: Partial<PromptVariable> = {}): PromptVariable => ({
  id: name, name, label: null, description: "", type: "text", defaultValue: null,
  required: false, position: 0, min: null, max: null, options: null, ...over,
});

describe("initialValues", () => {
  it("is each default as a string under the stored name: true is \"true\", none is \"\"", () => {
    expect(initialValues([
      variable("subject", { defaultValue: "a fox" }),
      variable("rain", { type: "checkbox", defaultValue: true }),
      variable("fog", { type: "checkbox", defaultValue: false }),
      variable("size", { type: "slider", defaultValue: 7 }),
      variable("styles", { type: "multi-select", defaultValue: ["ink", "oil"] }),
      variable("mood", { defaultValue: null }),
      variable("light", { defaultValue: undefined }),
    ])).toEqual({ subject: "a fox", rain: "true", fog: "false", size: "7", styles: "ink,oil", mood: "", light: "" });
  });
});

describe("what a value sends", () => {
  const box = (over: Partial<PromptVariable>) => variable("rain", { type: "checkbox", ...over });

  it("a ticked checkbox sends its description, else its label, else its name; an unticked one nothing", () => {
    expect(sendValue(box({ description: "heavy rain", label: "Rain" }), "true")).toBe("heavy rain");
    expect(sendValue(box({ label: "Rain" }), "true")).toBe("Rain");
    expect(sendValue(box({}), "true")).toBe("rain");
    expect(sendValue(box({ description: "heavy rain" }), "false")).toBe("");
    expect(sendValue(box({ description: "heavy rain" }), "")).toBe("");
  });

  it("anything else sends as it stands", () => {
    expect(sendValue(variable("styles", { type: "multi-select" }), "ink,oil")).toBe("ink,oil");
    expect(sendValue(undefined, "sky")).toBe("sky");
  });

  it("toServerValues keys every stored variable by its stored name", () => {
    const vars = [variable("subject", { label: "Subject" }), box({ description: "heavy rain" }), variable("mood")];
    expect(toServerValues(vars, { subject: "a fox", rain: "true", sky: "red" })).toEqual({ subject: "a fox", rain: "heavy rain", mood: "" });
  });
});

describe("isFilled", () => {
  it("text, choices, sliders and typed slots need more than spaces", () => {
    for (const type of ["text", "single-select", "radio", "slider"]) {
      expect(isFilled(variable("v", { type }), "")).toBe(false);
      expect(isFilled(variable("v", { type }), "  ")).toBe(false);
      expect(isFilled(variable("v", { type }), "x")).toBe(true);
    }
    expect(isFilled(undefined, " ")).toBe(false);
    expect(isFilled(undefined)).toBe(false);
    expect(isFilled(undefined, "sky")).toBe(true);
  });

  it("a checkbox is always filled, a multi-select unless it is required", () => {
    expect(isFilled(variable("v", { type: "checkbox" }), "")).toBe(true);
    expect(isFilled(variable("v", { type: "multi-select" }), "")).toBe(true);
    expect(isFilled(variable("v", { type: "multi-select", required: true }), "")).toBe(false);
    expect(isFilled(variable("v", { type: "multi-select", required: true }), "ink")).toBe(true);
  });
});

describe("fieldsFor", () => {
  const b = variable("b_var", { label: "Bee", position: 2 });
  const a = variable("a_var", { position: 1 });
  const pic = variable("pic", { type: "image", position: 0 });

  it("without a text: every stored variable by position, named by label else name, images left out", () => {
    expect(fieldsFor([b, pic, a], null)).toEqual([
      { key: "a_var", label: "a_var", variable: a },
      { key: "b_var", label: "Bee", variable: b },
    ]);
  });

  it("with a text: its slots in order, each once, a typed one under its own text", () => {
    const segs = parseSegments("[b var] and [sky], [Bee] [pic]", [a, b, pic]);
    expect(fieldsFor([a, b, pic], segs)).toEqual([
      { key: "b_var", label: "Bee", variable: b },
      { key: "sky", label: "sky", variable: undefined },
    ]);
  });
});

describe("missingRequired", () => {
  const fields = fieldsFor([
    variable("rain", { type: "checkbox", position: 1 }),
    variable("subject", { label: "Subject", position: 2 }),
    variable("mood", { label: "Mood", position: 3 }),
  ], null);

  it("is the first field Generate may not go without, so the surface can focus it", () => {
    expect(missingRequired(fields, { rain: "", subject: " ", mood: "" })).toMatchObject({ key: "subject", label: "Subject" });
    expect(missingRequired(fields, { rain: "", subject: "a fox", mood: "" })).toMatchObject({ key: "mood" });
  });

  it("is null once every field is filled", () => {
    expect(missingRequired(fields, { subject: "a fox", mood: "calm" })).toBeNull();
  });
});

describe("valueRows", () => {
  it("lists each field's value; a checkbox by its text and whether it was ticked", () => {
    const fields = fieldsFor([
      variable("rain", { type: "checkbox", label: "Rain", description: "heavy rain", position: 1 }),
      variable("subject", { label: "Subject", position: 2 }),
      variable("mood", { position: 3 }),
    ], null);
    expect(valueRows(fields, { rain: "false", subject: "a fox" })).toEqual([
      { name: "Rain", value: "heavy rain", checked: false },
      { name: "Subject", value: "a fox" },
      { name: "mood", value: "" },
    ]);
    expect(valueRows(fields, { rain: "true" })[0].checked).toBe(true);
    expect(valueRows(fields, {})[0].checked).toBe(false);
  });
});
