import { describe, it, expect } from "vitest";
import { holdKeys, releaseKey } from "../grow-only";

describe("the grow-only set", () => {
  it("holds the fields an image's values filled, adding to those held", () => {
    expect([...holdKeys(new Set(["a"]), ["b", "c"])].sort()).toEqual(["a", "b", "c"]);
  });

  it("releases one field and keeps the others held", () => {
    expect([...releaseKey(new Set(["a", "b"]), "a")]).toEqual(["b"]);
  });

  it("stays the very same set when nothing changes, so a keystroke re-renders nothing", () => {
    const held = new Set(["a"]);
    expect(releaseKey(held, "x")).toBe(held);
    expect(holdKeys(held, ["a"])).toBe(held);
    expect(holdKeys(held, [])).toBe(held);
  });

  it("never edits the set it was given", () => {
    const held = new Set(["a"]);
    holdKeys(held, ["b"]);
    releaseKey(held, "a");
    expect([...held]).toEqual(["a"]);
  });
});
