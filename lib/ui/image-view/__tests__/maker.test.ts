import { describe, expect, it } from "vitest";
import { madeBy, makerMark } from "../maker";

/** The strip names who made an image instead of "Made with this prompt", and links to them unless it is you (Kev, 2026-10-13). */
describe("makerMark", () => {
  it("is the handle as a link, the display name as text, You never linked, nothing for nobody", () => {
    expect(makerMark({ handle: "ada", name: "Ada", mine: false })).toEqual({ text: "@ada", link: "ada" });
    expect(makerMark({ handle: null, name: "Ada", mine: false })).toEqual({ text: "Ada", link: null });
    expect(makerMark({ handle: "ada", name: "Ada", mine: true })).toEqual({ text: "You", link: null });
    expect(makerMark({ handle: null, name: null, mine: false })).toBeNull();
    expect(makerMark(undefined)).toBeNull();
  });
});

describe("madeBy", () => {
  it("says who, or that it is another member's, never the old row title", () => {
    expect(madeBy({ handle: "ada", name: null, mine: false })).toBe("Made by @ada");
    expect(madeBy({ handle: null, name: "Ada", mine: false })).toBe("Made by Ada");
    expect(madeBy({ handle: "ada", name: null, mine: true })).toBe("Made by you");
    expect(madeBy(undefined)).toBe("Made by another member");
    expect(madeBy({ handle: null, name: null, mine: false })).toBe("Made by another member");
  });
});
