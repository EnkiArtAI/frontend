import { describe, it, expect } from "vitest";
import { limitsFor } from "@/hooks/useModelLimits";

/**
 * Quick create names its model by catalogue id, the row's own id: matching
 * only display-name slugs fell back to the defaults (14 references), and
 * GPT-Image-2's 16 were refused in the UI the server would take.
 */

const ROWS = [
  { id: "7d1e2f3a-0000-4000-8000-000000000001", name: "GPT Image 2", max_reference_images: 16, allowed_filetypes: ["image/png", "image/jpeg"] },
  { id: "7d1e2f3a-0000-4000-8000-000000000002", name: "Nano Banana Pro", max_reference_images: 14 },
];

describe("limitsFor", () => {
  it("finds a model by its catalogue id", () => {
    expect(limitsFor(ROWS, ROWS[0].id)).toMatchObject({ maxRefs: 16, filetypes: ["image/png", "image/jpeg"] });
  });

  it("still finds one by a slug of its name", () => {
    expect(limitsFor(ROWS, "gpt-image-2").maxRefs).toBe(16);
    expect(limitsFor(ROWS, "Nano Banana Pro").maxRefs).toBe(14);
  });

  it("falls back to the defaults for a model it does not know", () => {
    expect(limitsFor(ROWS, "7d1e2f3a-0000-4000-8000-00000000000f").maxRefs).toBe(14);
  });
});
