import { describe, it, expect } from "vitest";
import { swipeOf, viewerKey, viewerRatio } from "../fullscreen";

const free = { sheet: false, inside: true, typing: false };

describe("a key in the fullscreen viewer", () => {
  it("closes on Esc and pages on the arrows", () => {
    expect(viewerKey("Escape", free)).toBe("close");
    expect(viewerKey("ArrowLeft", free)).toBe("prev");
    expect(viewerKey("ArrowRight", free)).toBe("next");
    expect(viewerKey("Enter", free)).toBeNull();
  });

  it("does nothing while a bottom sheet is open over it, Esc included", () => {
    for (const key of ["Escape", "ArrowLeft", "ArrowRight"]) expect(viewerKey(key, { ...free, sheet: true })).toBeNull();
  });

  it("does nothing while focus is outside it, in a dialog opened over it", () => {
    for (const key of ["Escape", "ArrowLeft", "ArrowRight"]) expect(viewerKey(key, { ...free, inside: false })).toBeNull();
  });

  it("never pages while the user types in a field, but Esc still closes", () => {
    expect(viewerKey("ArrowLeft", { ...free, typing: true })).toBeNull();
    expect(viewerKey("ArrowRight", { ...free, typing: true })).toBeNull();
    expect(viewerKey("Escape", { ...free, typing: true })).toBe("close");
  });
});

describe("a swipe on the viewer's image", () => {
  it("pages when it goes more than 40 px sideways", () => {
    expect(swipeOf(-60, 10)).toBe(1);
    expect(swipeOf(60, -10)).toBe(-1);
    expect(swipeOf(30, 0)).toBe(0);
  });

  it("is a scroll, not a swipe, when it went more up or down", () => {
    expect(swipeOf(-60, 80)).toBe(0);
    expect(swipeOf(60, -60)).toBe(0);
  });
});

describe("the viewer's image box", () => {
  it("takes the picture's own shape once loaded, the asked ratio before, else square", () => {
    expect(viewerRatio(1.75, "16:9")).toBe(1.75);
    expect(viewerRatio(undefined, "4:5")).toBe(0.8);
    expect(viewerRatio(undefined, "21:9")).toBeCloseTo(21 / 9);
    expect(viewerRatio(undefined, null)).toBe(1);
  });
});
