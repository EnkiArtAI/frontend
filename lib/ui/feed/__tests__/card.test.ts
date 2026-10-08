import { describe, expect, it } from "vitest";
import { priceChipLabel, seedFromFeedCard, toFeedCard } from "../card";

const row = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  title: "  Brass  ",
  priceUsdCents: 40,
  category: "Photography",
  showcaseImages: [{ url: "https://a/1.webp" }, { url: "https://a/2.webp" }],
  previewImages: [{ url: "https://a/1.webp" }, { url: "https://a/3.webp" }],
  aspectRatio: "16:9",
  creator: { id: "u1", handle: "mara", displayName: "Mara K" },
  promptType: "premium",
  isFreeShowcase: false,
  ...over,
});

describe("priceChipLabel", () => {
  it("says FREE at 0 cents and dollars from cents otherwise", () => {
    expect(priceChipLabel(0)).toBe("FREE");
    expect(priceChipLabel(40)).toBe("$0.40");
    expect(priceChipLabel(1)).toBe("$0.01");
    expect(priceChipLabel(125)).toBe("$1.25");
    expect(priceChipLabel(2000)).toBe("$20.00");
  });
  it("shows no chip for a price that is not whole cents", () => {
    for (const bad of [null, undefined, -5, 1.5, Number.NaN, "40"]) expect(priceChipLabel(bad)).toBeNull();
  });
});

describe("toFeedCard", () => {
  it("maps the payload and invents nothing", () => {
    expect(toFeedCard(row())).toEqual({
      id: "p1",
      title: "Brass",
      priceCents: 40,
      category: "photography",
      images: ["https://a/1.webp", "https://a/2.webp", "https://a/3.webp"],
      ratio: 16 / 9,
      creator: { id: "u1", handle: "mara", name: "Mara K" },
      publicText: false,
    });
  });
  it("has no image, title or price when the payload has none", () => {
    const c = toFeedCard({ id: "p2" })!;
    expect(c.images).toEqual([]);
    expect(c.title).toBe("");
    expect(c.priceCents).toBeNull();
    expect(c.category).toBe("");
    expect(c.creator).toBeNull();
    expect(Object.keys(c)).not.toContain("promptTemplate");
  });
  it("drops empty and non-string image entries, showcase first", () => {
    const c = toFeedCard(row({ showcaseImages: [{ url: "" }, { url: 7 }, "https://a/s.webp"], previewImages: [null, { url: " https://a/p.webp " }] }))!;
    expect(c.images).toEqual(["https://a/s.webp", "https://a/p.webp"]);
  });
  it("keeps only whole, non-negative cents", () => {
    expect(toFeedCard(row({ priceUsdCents: 0 }))!.priceCents).toBe(0);
    expect(toFeedCard(row({ priceUsdCents: 1.5 }))!.priceCents).toBeNull();
    expect(toFeedCard(row({ priceUsdCents: -1 }))!.priceCents).toBeNull();
  });
  it("names the creator by display name, else by handle", () => {
    expect(toFeedCard(row({ creator: { id: "u1", handle: "mara", displayName: "" } }))!.creator).toEqual({ id: "u1", handle: "mara", name: "mara" });
    expect(toFeedCard(row({ creator: null }))!.creator).toBeNull();
  });
  it("sizes the box from the prompt's ratio, 4:5 when it has none", () => {
    expect(toFeedCard(row({ aspectRatio: "1:1" }))!.ratio).toBe(1);
    expect(toFeedCard({ id: "p2" })!.ratio).toBe(0.8);
  });
  it("marks the words public for free and showcase prompts only", () => {
    expect(toFeedCard(row({ promptType: "free" }))!.publicText).toBe(true);
    expect(toFeedCard(row({ promptType: "showcase" }))!.publicText).toBe(true);
    expect(toFeedCard(row({ isFreeShowcase: true }))!.publicText).toBe(true);
    expect(toFeedCard(row())!.publicText).toBe(false);
  });
  it("drops a row without an id", () => {
    expect(toFeedCard(row({ id: "" }))).toBeNull();
    expect(toFeedCard(null)).toBeNull();
  });
});

describe("seedFromFeedCard", () => {
  it("hands the Image View what the card knows, and nothing it does not", () => {
    expect(seedFromFeedCard(toFeedCard(row())!)).toEqual({
      promptId: "p1",
      title: "Brass",
      artist: { handle: "mara", name: "Mara K", id: "u1" },
      imageUrl: "https://a/1.webp",
      showcase: ["https://a/1.webp", "https://a/2.webp", "https://a/3.webp"],
      isFree: false,
    });
    const bare = seedFromFeedCard(toFeedCard({ id: "p2", promptType: "free" })!);
    expect(bare).toEqual({ promptId: "p2", title: undefined, artist: undefined, imageUrl: undefined, showcase: [], isFree: true });
  });
});
