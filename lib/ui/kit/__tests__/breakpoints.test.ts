import { describe, expect, it } from "vitest";
import { COARSE, HOVER, PHONE, RAIL, TABS, columnsFor } from "../breakpoints";

/** Whether a window `width` px wide falls under the query's max-width clause. */
const under = (query: string, width: number) => {
  const max = /\(max-width: ([\d.]+)px\)/.exec(query);
  if (!max) throw new Error(`no max-width in ${query}`);
  return width <= Number(max[1]);
};

describe("the breakpoints", () => {
  it.each([
    ["PHONE", PHONE, 768],
    ["TABS", TABS, 1024],
    ["RAIL", RAIL, 1200],
  ])("%s holds below %ipx and lets that width go", (_name, query, edge) => {
    expect(under(query, edge - 1)).toBe(true);
    expect(under(query, edge - 0.5)).toBe(true);
    expect(under(query, edge)).toBe(false);
  });

  it("PHONE also takes a phone held sideways", () => {
    expect(PHONE).toBe("(max-width: 767.98px), (pointer: coarse) and (max-height: 500px)");
  });

  it("COARSE and HOVER ask the pointer, not the width", () => {
    expect(COARSE).toBe("(pointer: coarse)");
    expect(HOVER).toBe("(hover: hover) and (pointer: fine)");
  });
});

describe("columnsFor", () => {
  it.each([
    [0, 2],
    [1023, 2],
    [1024, 3],
    [1399, 3],
    [1400, 4],
    [2560, 4],
  ])("gives a %ipx container %i columns", (width, cols) => {
    expect(columnsFor(width)).toBe(cols);
  });
});
