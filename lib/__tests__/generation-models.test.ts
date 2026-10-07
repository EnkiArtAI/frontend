import { describe, it, expect } from "vitest";
import { __testing__, routeFor, boostTiers, withCapabilities } from "@/lib/generation/models";

const { fromRow } = __testing__;

const link = (role: string, key: string, model: string, extra: Record<string, unknown> = {}) => ({
  role,
  provider_model: model,
  active: true,
  providers: { key, audience: "public", active: true, ...extra },
});

const NANO = { id: "m1", name: "Nano Banana Pro", allowed_ratios: ["1:1"], max_reference_images: 18 };

describe("model → route resolution", () => {
  it("uses the database links when they exist", () => {
    const m = fromRow(
      {
        ...NANO,
        model_providers: [
          link("normal", "wavespeed", "google/nano-banana-pro/text-to-image"),
          link("boost", "gemini", "gemini-3-pro-image-preview"),
        ],
      },
      "public",
    );
    expect(m.normal).toEqual({ provider: "wavespeed", providerModel: "google/nano-banana-pro/text-to-image" });
    expect(m.boost).toEqual({ provider: "gemini", providerModel: "gemini-3-pro-image-preview" });
    expect(routeFor(m, true)).toEqual(m.boost);
    expect(routeFor(m, false)).toEqual(m.normal);
    expect(routeFor(m, undefined)).toEqual(m.normal);
  });

  it("takes the lowest-priority normal row as the default, in whatever order the rows come", () => {
    const m = fromRow(
      {
        ...NANO,
        name: "Nano Banana 2",
        model_providers: [
          { ...link("normal", "gemini", "gemini-3.1-flash-image"), priority: 20 },
          { ...link("normal", "wavespeed", "google/nano-banana-2/text-to-image-fast"), priority: 10 },
          { ...link("boost", "gemini", "gemini-3.1-flash-image"), priority: 10 },
        ],
      },
      "public",
    );
    expect(m.normal).toEqual({ provider: "wavespeed", providerModel: "google/nano-banana-2/text-to-image-fast" });
    expect(m.maxResolution).toBe("4K");
  });

  it("falls back to the slug bridge when the migration has not run", () => {
    const m = fromRow(NANO, "public");
    // Gemini direct on both legs since 2026-09-05 (WaveSpeed raised 1K/2K to
    // $0.14; Gemini stays $0.134 and is the faster host) — boost === normal.
    expect(m.normal.provider).toBe("gemini");
    expect(m.boost.provider).toBe("gemini");
  });

  it("makes boost a no-op — never a wrong host — when no boost row exists", () => {
    const m = fromRow({ ...NANO, model_providers: [link("normal", "openai", "gpt-image-2")] }, "public");
    expect(m.normal.providerModel).toBe("gpt-image-2");
    // Must equal normal, NOT the bridge's gemini route: the row said openai.
    expect(m.boost).toEqual(m.normal);
    expect(routeFor(m, true).provider).toBe("openai");
  });

  it("hides an enterprise-only provider from a public caller", () => {
    const row = {
      ...NANO,
      model_providers: [
        link("normal", "wavespeed", "google/nano-banana-pro/text-to-image"),
        link("boost", "gemini", "secret-enterprise-model", { audience: "enterprise" }),
      ],
    };

    const pub = fromRow(row, "public");
    expect(pub.boost.providerModel).not.toBe("secret-enterprise-model");
    expect(pub.boost).toEqual(pub.normal); // degrades, does not leak

    const ent = fromRow(row, "enterprise");
    expect(ent.boost.providerModel).toBe("secret-enterprise-model");
  });

  it("ignores a deactivated link or a deactivated provider", () => {
    const deadLink = fromRow(
      { ...NANO, model_providers: [{ ...link("normal", "wavespeed", "x"), active: false }] },
      "public",
    );
    expect(deadLink.normal.providerModel).not.toBe("x");

    const deadProvider = fromRow(
      { ...NANO, model_providers: [link("normal", "wavespeed", "y", { active: false })] },
      "public",
    );
    expect(deadProvider.normal.providerModel).not.toBe("y");
  });

  it("gives a row with no provider rows and no bridge entry no route, never a guessed one", () => {
    // ENG-01: the old fallback routed any unknown name to Nano Banana Pro.
    const m = fromRow({ id: "m2", name: "Nano Banana" }, "public");
    expect(m.normal).toEqual({ provider: "none", providerModel: "" });
    expect(m.boost).toEqual({ provider: "none", providerModel: "" });
    expect(m.supportsResolution).toBe(false);
    expect(fromRow(NANO, "public").supportsResolution).toBe(true);
  });

  it("keeps per-model limits from the row, not the defaults", () => {
    const m = fromRow(NANO, "public");
    expect(m.maxRefs).toBe(18);
    expect(m.maxRefs).not.toBe(3); // the column default for rows that predate it
    expect(m.allowedRatios).toEqual(["1:1"]);
  });
});

describe("boostTiers", () => {
  // Nano Banana 2 as the catalogue will carry it: Fast first at 2K/4K, Google
  // at 1K and as the fallback, Google as the boost host.
  const NB2 = {
    id: "m3", name: "Nano Banana 2", allowed_ratios: ["1:1"], max_reference_images: 14,
    model_providers: [
      { ...link("normal", "gemini", "gemini-3.1-flash-image"), priority: 20 },
      { ...link("normal", "wavespeed", "google/nano-banana-2/text-to-image-fast"), priority: 10, applies_when: { resolution: ["2K", "4K"] } },
      { ...link("normal", "wavespeed", "google/nano-banana-2/text-to-image"), priority: 30 },
      { ...link("boost", "gemini", "gemini-3.1-flash-image"), priority: 10 },
    ],
  };

  it("names only the sizes where the boost host is not already the regular one", () => {
    expect(boostTiers(fromRow(NB2, "public"))).toEqual(["2K", "4K"]);
    const [cat] = withCapabilities([NB2]);
    expect(cat.boostTiers).toEqual(["2K", "4K"]);
    expect(cat.boostAvailable).toBe(true);
  });

  it("is empty when the regular host is the boost host at every size", () => {
    // Nano Banana Pro with Google first (the SQL of 2026-10-06).
    const row = { ...NANO, model_providers: [
      { ...link("normal", "gemini", "gemini-3-pro-image"), priority: 10 },
      { ...link("normal", "wavespeed", "google/nano-banana-pro/text-to-image"), priority: 20 },
      { ...link("boost", "gemini", "gemini-3-pro-image"), priority: 10 },
    ] };
    expect(boostTiers(fromRow(row, "public"))).toEqual([]);
    expect(withCapabilities([row])[0].boostAvailable).toBe(false);
  });

  it("stops at the model's largest size", () => {
    const m = fromRow({ ...NANO, model_providers: [
      { ...link("normal", "wavespeed", "google/nano-banana-pro/text-to-image"), priority: 10 },
      { ...link("boost", "gemini", "gemini-3-pro-image"), priority: 10 },
    ] }, "public");
    expect(boostTiers(m)).toEqual(["1K", "2K", "4K"]);
    expect(boostTiers({ ...m, maxResolution: "2K" })).toEqual(["1K", "2K"]);
  });

  it("tells two model ids on the same host apart", () => {
    const m = fromRow({ ...NANO, model_providers: [
      { ...link("normal", "gemini", "gemini-3.1-flash-image"), priority: 10 },
      { ...link("boost", "gemini", "gemini-3-pro-image"), priority: 10 },
    ] }, "public");
    expect(boostTiers(m)).toEqual(["1K", "2K", "4K"]);
    // ...and the same model id on two hosts (an unknown id renders 1K only).
    const h = fromRow({ ...NANO, model_providers: [
      { ...link("normal", "wavespeed", "x"), priority: 10 },
      { ...link("boost", "gemini", "x"), priority: 10 },
    ] }, "public");
    expect(boostTiers(h)).toEqual(["1K"]);
  });

  it("does not offer a public buyer a boost host that is not public", () => {
    const m = fromRow({ ...NANO, model_providers: [
      { ...link("normal", "wavespeed", "google/nano-banana-pro/text-to-image"), priority: 10 },
      { ...link("boost", "gemini", "gemini-3-pro-image", { audience: "enterprise" }), priority: 10 },
    ] }, "public");
    expect(boostTiers(m)).toEqual([]);
    expect(boostTiers(m, "enterprise")).toEqual(["1K", "2K", "4K"]);
  });
});

describe("hasBoost", () => {
  it("is true only when the boost route really differs", async () => {
    const { hasBoost } = await import("@/lib/generation/models");

    const twoHosts = fromRow(
      { ...NANO, model_providers: [link("normal", "wavespeed", "google/nano-banana-pro/text-to-image"), link("boost", "gemini", "gemini-3-pro-image-preview")] },
      "public",
    );
    expect(hasBoost(twoHosts)).toBe(true);

    // No boost row: routes collapse, so the button must not be offered.
    const oneHost = fromRow({ ...NANO, model_providers: [link("normal", "openai", "gpt-image-2")] }, "public");
    expect(hasBoost(oneHost)).toBe(false);

    // Enterprise boost hidden from a public caller — no boost for them either,
    // which is the point: the UI must not advertise what it cannot deliver.
    const gated = fromRow(
      { ...NANO, model_providers: [link("normal", "wavespeed", "x"), link("boost", "gemini", "y", { audience: "enterprise" })] },
      "public",
    );
    expect(hasBoost(gated)).toBe(false);
  });
});
