import { describe, it, expect } from "vitest";
import { dropSide, refRoom, refToken, tileLook } from "../tile";

describe("a job tile's look", () => {
  it("frames a finished render in turq until it is seen, then shows a ✓ instead", () => {
    expect(tileLook({ status: "ready", seen: false })).toEqual({ frame: "turq", check: false });
    expect(tileLook({ status: "ready", seen: true })).toEqual({ frame: "none", check: true });
  });

  it("frames a failed render in danger, and a rendering one not at all, and gives neither a ✓", () => {
    expect(tileLook({ status: "failed", seen: false })).toEqual({ frame: "danger", check: false });
    expect(tileLook({ status: "rendering", seen: false })).toEqual({ frame: "none", check: false });
    expect(tileLook({ status: "failed", seen: true }).check).toBe(false);
  });

  it("frames the selected or starred image in ember, first of all", () => {
    expect(tileLook({ status: "ready", seen: false, selected: true }).frame).toBe("ember");
    expect(tileLook({ status: "failed", seen: false, selected: true }).frame).toBe("ember");
    expect(tileLook({ status: "ready", seen: true, starred: true })).toEqual({ frame: "ember", check: true });
  });
});

describe("reference tiles", () => {
  it("take no more images than the cap leaves, counting those still being read", () => {
    expect(refRoom(4, 1)).toBe(3);
    expect(refRoom(4, 4)).toBe(0);
    expect(refRoom(4, 6)).toBe(0);
  });

  it("drop the token of their own place, counted from 1", () => {
    expect(refToken(0)).toBe("[Reference image 1]");
    expect(refToken(2)).toBe("[Reference image 3]");
  });

  it("mark the side a dragged tile will land on, and nothing on itself", () => {
    expect(dropSide(3, 1)).toBe("before");
    expect(dropSide(1, 3)).toBe("after");
    expect(dropSide(2, 2)).toBeNull();
  });
});
