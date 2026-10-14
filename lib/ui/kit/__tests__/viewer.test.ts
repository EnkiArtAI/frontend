import { describe, it, expect } from "vitest";
import { swipeStep, clampIndex, showDots } from "../viewer";

describe("viewer paging", () => {
  it("pages on a swipe of more than 40 px: left is next, right is previous", () => {
    expect(swipeStep(-41)).toBe(1);
    expect(swipeStep(41)).toBe(-1);
    expect(swipeStep(-40)).toBe(0);
    expect(swipeStep(40)).toBe(0);
    expect(swipeStep(0)).toBe(0);
  });

  it("stops at both ends", () => {
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(3, 3)).toBe(2);
    expect(clampIndex(1, 3)).toBe(1);
  });

  it("shows dots for 2 to 12 images", () => {
    expect(showDots(1)).toBe(false);
    expect(showDots(2)).toBe(true);
    expect(showDots(12)).toBe(true);
    expect(showDots(13)).toBe(false);
  });
});
