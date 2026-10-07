import { describe, it, expect } from "vitest";
import {
  normalizeTier,
  maxTier,
  clampTier,
  tiersUpTo,
  RESOLUTION_TIERS,
} from "@/lib/generation/resolution";

/**
 * The behaviour under test is a promise about what a buyer receives, so every
 * case here is one that was live-wrong before this module existed.
 */
describe("normalizeTier", () => {
  it("accepts the tiers exactly as the UI writes them", () => {
    expect(normalizeTier("1K")).toBe("1K");
    expect(normalizeTier("2K")).toBe("2K");
    expect(normalizeTier("4K")).toBe("4K");
  });

  it("repairs the lowercase spelling the editor paths send", () => {
    // The old editor paths sent "4k". The route cast it
    // straight to the union, WaveSpeed's map missed it and fell back to '1k',
    // and the price ladder charged $0.25 for the smallest tier.
    expect(normalizeTier("4k")).toBe("4K");
    expect(normalizeTier(" 2k ")).toBe("2K");
  });

  it("refuses anything that is not a tier instead of defaulting", () => {
    // A default here is how a junk value becomes a silent 1K render at a 4K
    // price. null forces the caller to decide.
    for (const junk of ["", "8K", "1080p", "4", "K4", null, undefined, 4, {}, []]) {
      expect(normalizeTier(junk)).toBeNull();
    }
  });
});

describe("maxTier", () => {
  it("gives 4K only to routes whose docs state 4K", () => {
    expect(maxTier("gemini", "gemini-3-pro-image")).toBe("4K");
    expect(maxTier("wavespeed", "google/nano-banana-pro/text-to-image")).toBe("4K");
    expect(maxTier("wavespeed", "google/nano-banana-pro/edit")).toBe("4K");
    expect(maxTier("wavespeed", "openai/gpt-image-2/text-to-image")).toBe("4K");
    expect(maxTier("openai", "gpt-image-2")).toBe("4K");
  });

  it("caps flux at 2K, because 4K there returns a 2K image", () => {
    // Measured on the live rows: a 4K and a 2K request both came back 686x858.
    expect(maxTier("pollinations", "flux")).toBe("2K");
  });

  it("caps gemini-2.5-flash-image at 1K, which is all it can return", () => {
    expect(maxTier("gemini", "gemini-2.5-flash-image")).toBe("1K");
  });

  it("fails CLOSED for anything it does not know", () => {
    // The bridge this replaced defaulted an unknown model NAME to the Nano
    // Banana Pro entry, so a new row was billed by resolution against a host
    // that might ignore the field entirely.
    expect(maxTier("wavespeed", "some/model/nobody/added")).toBe("1K");
    expect(maxTier("acedata", "whatever")).toBe("1K");
    expect(maxTier(undefined, undefined)).toBe("1K");
    expect(maxTier("", "")).toBe("1K");
  });

  it("does not let one provider's model id unlock another provider's ceiling", () => {
    expect(maxTier("openai", "gemini-3-pro-image")).toBe("1K");
    expect(maxTier("gemini", "google/nano-banana-pro/text-to-image")).toBe("1K");
  });
});

describe("clampTier", () => {
  it("passes a tier through when the route can render it", () => {
    expect(clampTier("4K", "gemini", "gemini-3-pro-image")).toBe("4K");
    expect(clampTier("1K", "pollinations", "flux")).toBe("1K");
  });

  it("brings a request down to what the route actually delivers", () => {
    expect(clampTier("4K", "pollinations", "flux")).toBe("2K");
    expect(clampTier("4K", "gemini", "gemini-2.5-flash-image")).toBe("1K");
    expect(clampTier("2K", "gemini", "gemini-2.5-flash-image")).toBe("1K");
  });

  it("never raises a request", () => {
    // Cheap to get wrong with a min/max slip, and expensive: it would render
    // 4K on a tier the buyer did not pay for.
    for (const t of RESOLUTION_TIERS) {
      expect(clampTier(t, "gemini", "gemini-3-pro-image")).toBe(t);
    }
    expect(clampTier("1K", "wavespeed", "google/nano-banana-pro/text-to-image")).toBe("1K");
  });
});

describe("tiersUpTo", () => {
  it("builds the picker from the ceiling, in ascending order", () => {
    expect(tiersUpTo("4K")).toEqual(["1K", "2K", "4K"]);
    expect(tiersUpTo("2K")).toEqual(["1K", "2K"]);
    expect(tiersUpTo("1K")).toEqual(["1K"]);
  });

  it("never offers a tier the route cannot render", () => {
    for (const route of [
      ["pollinations", "flux"],
      ["gemini", "gemini-2.5-flash-image"],
      ["wavespeed", "google/nano-banana-pro/text-to-image"],
    ] as const) {
      const cap = maxTier(route[0], route[1]);
      for (const t of tiersUpTo(cap)) {
        expect(clampTier(t, route[0], route[1])).toBe(t);
      }
    }
  });
});
