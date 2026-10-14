import { describe, it, expect } from "vitest";
import { parseRatio, boxRatio } from "../ratio";

describe("parseRatio", () => {
  it("is width over height", () => {
    expect(parseRatio("4:5")).toBe(0.8);
    expect(parseRatio("16:9")).toBe(16 / 9);
    expect(parseRatio("2.39:1")).toBe(2.39);
  });

  it("is null unless it is two positive numbers", () => {
    for (const bad of ["bad", "", "0:5", "5:0", "4:5:1", "-4:5", "4/5", " 4:5", null, undefined]) expect(parseRatio(bad), String(bad)).toBeNull();
  });
});

describe("boxRatio", () => {
  it("keeps a ratio inside 9:16 … 16:9, clamps outside, and is 4:5 when unknown", () => {
    expect(boxRatio("4:5")).toBe(0.8);
    expect(boxRatio("21:9")).toBe(16 / 9);
    expect(boxRatio("1:3")).toBe(9 / 16);
    expect(boxRatio("bad")).toBe(0.8);
    expect(boxRatio(null)).toBe(0.8);
  });
});
