import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The classic editor's "max user images" is the author's number; the images
 * allowed are that number within the selected model's cap. Writing the cap
 * over the number only ever lowered it: picking Flux (no references) left
 * every model after it at 0.
 */

const EDITOR = readSource(join(__dirname, "..", "..", "components", "EnkiPromptEditor.tsx"));

describe("the images an author's prompt allows", () => {
  it("are the author's number within the model's cap, never written over the number", () => {
    expect(EDITOR).toContain("const maxImages = Math.min(ui.maxImages, modelLimits.maxRefs);");
    expect(EDITOR).not.toMatch(/maxImages: modelLimits\.maxRefs/);
  });

  it("bound the author's own references, the limit message and the buyers' hint", () => {
    expect(EDITOR).toContain("if (referenceImages.length >= maxImages) {");
    expect(EDITOR).toContain("description: `You can add up to ${maxImages} reference image(s).`,");
    expect(EDITOR).toContain("disabled={referenceImages.length >= maxImages}");
    expect(EDITOR).toContain("up to {maxImages} per render.");
    expect(EDITOR).not.toMatch(/referenceImages\.length >= ui\.maxImages|up to \{ui\.maxImages\}/);
  });
});
