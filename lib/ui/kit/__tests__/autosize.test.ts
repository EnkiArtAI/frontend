import { describe, it, expect } from "vitest";
import { nextHeight } from "../autosize";

const field = { min: 40, max: 120 };

describe("nextHeight", () => {
  it("fits the content between min and max", () => {
    expect(nextHeight({ ...field, scrollHeight: 60, prev: 40, growOnly: false })).toEqual({ height: 62, overflowY: "hidden" });
    expect(nextHeight({ ...field, scrollHeight: 20, prev: 80, growOnly: false })).toEqual({ height: 40, overflowY: "hidden" });
  });

  it("stops at max and scrolls inside from there", () => {
    expect(nextHeight({ ...field, scrollHeight: 300, prev: 40, growOnly: false })).toEqual({ height: 120, overflowY: "auto" });
    expect(nextHeight({ ...field, scrollHeight: 118, prev: 40, growOnly: false })).toEqual({ height: 120, overflowY: "hidden" });
    expect(nextHeight({ ...field, scrollHeight: 119, prev: 40, growOnly: false })).toEqual({ height: 120, overflowY: "auto" });
  });

  it("never shrinks while grow-only, and grows", () => {
    expect(nextHeight({ ...field, scrollHeight: 20, prev: 80, growOnly: true })).toEqual({ height: 80, overflowY: "hidden" });
    expect(nextHeight({ ...field, scrollHeight: 90, prev: 80, growOnly: true })).toEqual({ height: 92, overflowY: "hidden" });
  });

  it("keeps the previous height while the field is not laid out", () => {
    expect(nextHeight({ ...field, scrollHeight: 9, prev: 73, growOnly: false })).toEqual({ height: 73, overflowY: "hidden" });
    expect(nextHeight({ ...field, scrollHeight: 10, prev: 73, growOnly: false }).height).toBe(40);
  });
});
