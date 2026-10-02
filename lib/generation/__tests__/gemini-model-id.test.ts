import { describe, expect, it } from "vitest";
import {
  estimateGeminiCost,
  isGemini3ProImage,
} from "@/backend/services/gemini-image-generation";

/*
 * Google shut down gemini-3-pro-image-preview on 2026-06-25 ("The
 * gemini-3-pro-image-preview models are deprecated and will be shut down on
 * June 25, 2026"). The GA id, released 2026-05-28, is gemini-3-pro-image. Our
 * live rows and our code both still carried the dead one on 2026-08-12, seven
 * weeks after the shutdown.
 *
 * Renaming it is the easy half. The dangerous half is that TWO behaviours
 * branched on the exact string, and both fail SILENTLY when it stops matching:
 *
 *   - imageSize is only attached for this family, so a miss means the buyer
 *     pays for 4K and receives 1024² with nothing reporting the difference;
 *   - the cost estimate only has a rate for this family, so a miss books a
 *     paid generation at $0.
 *
 * Neither raises an error. Both are exactly the failure this codebase keeps
 * producing, so both get a test rather than a careful rename.
 */

describe("the Gemini 3 Pro Image model is recognised by its GA id only", () => {
  it("matches the GA id", () => {
    expect(isGemini3ProImage("gemini-3-pro-image")).toBe(true);
  });

  it("no longer matches the shut-down preview id", () => {
    // ENG-01: the live model_providers rows carry the GA id (read 2026-10-02),
    // so the transition window that needed both ids is over.
    expect(isGemini3ProImage("gemini-3-pro-image-preview")).toBe(false);
  });

  it("does not match the flash model, which has different behaviour entirely", () => {
    // gemini-2.5-flash-image ignores imageSize and is priced per token at a
    // different rate; treating it as Pro would misprice and mis-size it.
    expect(isGemini3ProImage("gemini-2.5-flash-image")).toBe(false);
    expect(isGemini3ProImage("")).toBe(false);
    expect(isGemini3ProImage(null)).toBe(false);
    expect(isGemini3ProImage(undefined)).toBe(false);
  });
});

describe("a Pro generation is never costed at zero", () => {
  it("prices the GA id", () => {
    expect(estimateGeminiCost("gemini-3-pro-image", "2K", 1)).toBeGreaterThan(0);
  });

  it("still charges more for 4K than for 1K", () => {
    // The tier table is the only thing that makes resolution cost anything;
    // if the id stops matching, every tier collapses to the same zero.
    expect(estimateGeminiCost("gemini-3-pro-image", "4K", 1)).toBeGreaterThan(
      estimateGeminiCost("gemini-3-pro-image", "1K", 1),
    );
  });
});
