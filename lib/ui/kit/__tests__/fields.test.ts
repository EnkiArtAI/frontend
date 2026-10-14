import { describe, it, expect } from "vitest";
import { choiceAsPills, fieldKind, multiValues, sliderRange, toggleMulti, valueText } from "../fields";

const opts = (...keys: string[]) => keys.map((k) => ({ promptValue: k, visibleName: k.toUpperCase() }));

describe("how a buyer variable is asked", () => {
  it("by its type", () => {
    expect(fieldKind({ type: "text", options: null })).toBe("text");
    expect(fieldKind({ type: "checkbox", options: null })).toBe("check");
    expect(fieldKind({ type: "slider", options: null })).toBe("slider");
    expect(fieldKind({ type: "single-select", options: opts("a") })).toBe("choice");
    expect(fieldKind({ type: "radio", options: opts("a") })).toBe("choice");
    expect(fieldKind({ type: "multi-select", options: opts("a") })).toBe("multi");
  });

  it("not at all for a reference image, which takes no value", () => {
    expect(fieldKind({ type: "image", options: null })).toBeNull();
  });

  it("as text when a choice has no options or the type is unknown", () => {
    expect(fieldKind({ type: "single-select", options: [] })).toBe("text");
    expect(fieldKind({ type: "radio", options: null })).toBe("text");
    expect(fieldKind({ type: "multi-select", options: null })).toBe("text");
    expect(fieldKind({ type: "number", options: null })).toBe("text");
  });

  it("as pills for up to five choices, else in a menu", () => {
    expect(choiceAsPills(5)).toBe(true);
    expect(choiceAsPills(6)).toBe(false);
  });
});

describe("a multi-select's value", () => {
  it("lists the chosen promptValues, comma-joined", () => {
    expect(multiValues("a,c")).toEqual(["a", "c"]);
    expect(multiValues("")).toEqual([]);
  });

  it("adds a tapped option and removes it on the next tap, in option order", () => {
    const o = opts("a", "b", "c");
    expect(toggleMulti("", "b", o)).toBe("b");
    expect(toggleMulti("c", "a", o)).toBe("a,c");
    expect(toggleMulti("a,c", "a", o)).toBe("c");
  });

  it("drops a value that is no longer an option", () => {
    expect(toggleMulti("gone,a", "b", opts("a", "b"))).toBe("a,b");
  });
});

describe("a slider", () => {
  it("runs from 0 to 100 unless the creator set its ends", () => {
    expect(sliderRange({ min: null, max: null }, "40")).toEqual({ min: 0, max: 100, value: 40 });
    expect(sliderRange({ min: 5, max: 9 }, "7")).toEqual({ min: 5, max: 9, value: 7 });
  });

  it("holds its value inside the range, at the low end when there is none", () => {
    expect(sliderRange({ min: 5, max: 9 }, "12").value).toBe(9);
    expect(sliderRange({ min: 5, max: 9 }, "1").value).toBe(5);
    expect(sliderRange({ min: 5, max: 9 }, "").value).toBe(5);
    expect(sliderRange({ min: 5, max: 9 }, "abc").value).toBe(5);
    expect(sliderRange({ min: -5, max: 5 }, " ").value).toBe(-5);
  });
});

describe("a value row", () => {
  it("shows the value, or a dash when it is empty", () => {
    expect(valueText({ value: "a red fox" })).toBe("a red fox");
    expect(valueText({ value: "" })).toBe("—");
  });

  it("puts a checkbox's text behind its box", () => {
    expect(valueText({ value: "film grain", checked: true })).toBe("☑ film grain");
    expect(valueText({ value: "film grain", checked: false })).toBe("☐ film grain");
  });
});
