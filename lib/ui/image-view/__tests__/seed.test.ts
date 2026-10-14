import { describe, expect, it } from "vitest";
import { mapMarketplacePromptToEnkiPrompt } from "@/lib/enkiPromptAdapter";
import { seedFromEnkiPrompt } from "../seed";

/* Records shaped like the feed's cards (lib/marketplace/card.ts), run through
   the real adapter, because the filler to drop is whatever the adapter makes. */
const A = "https://cdn.example/a.png";
const B = "https://cdn.example/b.png";
const C = "https://cdn.example/c.png";
const seed = (record: Record<string, unknown>) => seedFromEnkiPrompt(mapMarketplacePromptToEnkiPrompt(record));

describe("seedFromEnkiPrompt", () => {
  it("maps every field a card knows", () => {
    expect(seed({
      id: "p1",
      title: "Harbour at dusk",
      creator: { id: "u1", handle: "mara", displayName: "Mara K" },
      previewImages: [A, B, C],
      promptType: "free",
    })).toEqual({
      promptId: "p1",
      title: "Harbour at dusk",
      artist: { handle: "mara", name: "Mara K", id: "u1" },
      imageUrl: A,
      showcase: [A, B, C],
      isFree: true,
    });
  });

  it("drops the grey placeholders the adapter puts in for missing images", () => {
    const prompt = mapMarketplacePromptToEnkiPrompt({ id: "p2", showcaseImages: [A] });
    // The adapter always pads to four versions; three of these are filler.
    expect(prompt.versions).toHaveLength(4);
    expect(seedFromEnkiPrompt(prompt).showcase).toEqual([A]);
    expect(seed({ id: "p3" }).imageUrl).toBeUndefined();
    expect(seed({ id: "p3" }).showcase).toEqual([]);
  });

  it("keeps a real data: image; only the adapter's own filler goes", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(seed({ id: "p4", previewImageUrl: png }).imageUrl).toBe(png);
    expect(seed({ id: "p4", previewImageUrl: png }).showcase).toEqual([png]);
  });

  it("invents nothing for a card that knows nothing", () => {
    expect(seed({ id: "p5" })).toEqual({ promptId: "p5", showcase: [], isFree: false });
  });

  it("keeps a creator known only by id, without a made-up handle or name", () => {
    expect(seed({ id: "p6", userId: "u6" }).artist).toEqual({ id: "u6" });
  });

  it("does not call a paid prompt free", () => {
    expect(seed({ id: "p7", promptType: "premium", previewImages: [A] }).isFree).toBe(false);
  });
});
