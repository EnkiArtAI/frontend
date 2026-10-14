import { describe, it, expect } from "vitest";
import { mapMarketplacePromptToEnkiPrompt } from "@/lib/enkiPromptAdapter";

/**
 * The adapter used to guess the unit: anything up to 20 counted as dollars,
 * so a 5-cent prompt showed as $5 on the feed and the profile. priceUsdCents
 * is cents by its name and is always divided.
 */
const price = (fields: Record<string, unknown>) => mapMarketplacePromptToEnkiPrompt({ id: "p", title: "t", ...fields }).price;

describe("the feed price", () => {
  it("reads priceUsdCents as cents at every size", () => {
    expect(price({ priceUsdCents: 5 })).toBe(0.05);
    expect(price({ priceUsdCents: 20 })).toBe(0.2);
    expect(price({ priceUsdCents: 150 })).toBe(1.5);
  });

  it("keeps a free prompt free even when an older dollar field is set", () => {
    expect(price({ priceUsdCents: 0, price: 3 })).toBe(0);
  });

  it("reads the older fields as dollars, and nothing as free", () => {
    expect(price({ price: 2.5 })).toBe(2.5);
    expect(price({ pricing: { pricePerGeneration: 1 } })).toBe(1);
    expect(price({})).toBe(0);
  });
});
