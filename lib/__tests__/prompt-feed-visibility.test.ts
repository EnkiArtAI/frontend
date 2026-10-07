import { describe, it, expect } from "vitest";
import { mapMarketplacePromptToEnkiPrompt } from "@/lib/enkiPromptAdapter";

/**
 * The feed card opens the generator with isFreeShowcase = (visibility ===
 * "full"), which shows the prompt's words and lets the viewer copy them.
 * Feed records never carried the fields the adapter looked for, so every
 * paid prompt opened as free.
 */

const visibility = (record: Record<string, unknown>) =>
  mapMarketplacePromptToEnkiPrompt({ id: "p", title: "T", ...record }).visibility;

describe("a feed card shows a prompt's words only when it is free", () => {
  it("hides a paid prompt's words", () => {
    expect(visibility({ promptType: "paid", isFreeShowcase: false, priceUsdCents: 150 })).toBe("vars-only");
  });

  it("hides a record that says nothing about its type", () => {
    expect(visibility({})).toBe("vars-only");
  });

  it("shows a free showcase's words", () => {
    expect(visibility({ promptType: "create-now", isFreeShowcase: true })).toBe("full");
  });

  it("shows a free prompt's words", () => {
    expect(visibility({ promptType: "free" })).toBe("full");
  });
});
