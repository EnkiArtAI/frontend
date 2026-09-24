import { describe, it, expect } from "vitest";
import { mapMarketplacePromptToEnkiPrompt, normaliseShowcase } from "@/lib/enkiPromptAdapter";

/**
 * Showcase images reach the feed in three shapes: bare URL strings (the DB
 * column today), { url } objects (what the marketplace API wraps them in)
 * and { after, before, addition } objects once inputs are stored. The card
 * reads ONE shape, and the curtain shows only when a before survives.
 */
const A = "https://cdn.example/after-1.webp";
const A2 = "https://cdn.example/after-2.webp";
const B = "https://cdn.example/before-1.webp";
const B2 = "https://cdn.example/before-2.webp";

describe("normaliseShowcase", () => {
  it("bare strings become entries without a before or an addition", () => {
    expect(normaliseShowcase([A, A2])).toEqual([
      { after: A, before: null, addition: null },
      { after: A2, before: null, addition: null },
    ]);
  });

  it("{ url } objects (the API today) read like strings", () => {
    expect(normaliseShowcase([{ url: A }])).toEqual([{ after: A, before: null, addition: null }]);
  });

  it("{ after, before, addition } objects pass through as given", () => {
    expect(normaliseShowcase([{ after: A, before: B, addition: " neon rain " }])).toEqual([
      { after: A, before: B, addition: "neon rain" },
    ]);
  });

  it("a missing, null or empty before and addition are null", () => {
    expect(normaliseShowcase([{ after: A }, { after: A2, before: null, addition: "" }])).toEqual([
      { after: A, before: null, addition: null },
      { after: A2, before: null, addition: null },
    ]);
  });

  it("mixed arrays keep their order", () => {
    expect(normaliseShowcase([A, { after: A2, before: B2 }, { url: B }]).map((s) => [s.after, s.before])).toEqual([
      [A, null],
      [A2, B2],
      [B, null],
    ]);
  });

  it("entries without a usable after are dropped, unusable befores are nulled", () => {
    expect(
      normaliseShowcase([
        "",
        "   ",
        "not a url",
        "http://insecure.example/x.png",
        "blob:https://enki.art/1234",
        "javascript:alert(1)",
        "//protocol-relative.example/x.png",
        { after: "" },
        { before: B },
        { thumbnail: A },
        42,
        null,
        { after: A, before: "blob:https://enki.art/5678" },
        "/uploads/local.webp",
      ]),
    ).toEqual([
      { after: A, before: null, addition: null },
      { after: "/uploads/local.webp", before: null, addition: null },
    ]);
  });

  it("anything that is not an array is an empty showcase", () => {
    expect(normaliseShowcase(undefined)).toEqual([]);
    expect(normaliseShowcase("https://cdn.example/one.webp")).toEqual([]);
  });
});

describe("mapMarketplacePromptToEnkiPrompt showcase", () => {
  it("legacy strings: art.url unchanged, before null, showcase normalised", () => {
    const prompt = mapMarketplacePromptToEnkiPrompt({ id: "p1", showcaseImages: [A, A2], previewImages: [A, A2] });
    expect(prompt.art.url).toBe(A);
    expect(prompt.before).toBeNull();
    expect(prompt.showcase).toEqual([
      { after: A, before: null, addition: null },
      { after: A2, before: null, addition: null },
    ]);
  });

  it("today's API ({ url } objects): art.url and versions still resolve", () => {
    const urls = [A, A2, "https://cdn.example/after-3.webp"];
    const prompt = mapMarketplacePromptToEnkiPrompt({
      id: "p2",
      previewImages: urls.map((url) => ({ url })),
      showcaseImages: urls.map((url) => ({ url })),
    });
    expect(prompt.art.url).toBe(A);
    expect(prompt.versions.map((v) => v.url).slice(0, 2)).toEqual([A2, urls[2]]);
    expect(prompt.versions[2].url.startsWith("data:image/svg+xml")).toBe(true);
    expect(prompt.before).toBeNull();
  });

  it("objects: the primary before is the FIRST entry's before, versions read .after", () => {
    const prompt = mapMarketplacePromptToEnkiPrompt({
      id: "p3",
      showcaseImages: [
        { after: A, before: B, addition: "gold leaf" },
        { after: A2, before: B2 },
      ],
    });
    expect(prompt.art.url).toBe(A);
    expect(prompt.before).toBe(B);
    expect(prompt.versions[0].url).toBe(A2);
    expect(prompt.showcase[1]).toEqual({ after: A2, before: B2, addition: null });
  });

  it("a first entry without a before gives no curtain, even when a later one has one", () => {
    const prompt = mapMarketplacePromptToEnkiPrompt({ id: "p4", showcaseImages: [A, { after: A2, before: B2 }] });
    expect(prompt.before).toBeNull();
    expect(prompt.showcase[1].before).toBe(B2);
  });

  it("an invalid first entry is dropped, so the next one becomes the primary image", () => {
    const prompt = mapMarketplacePromptToEnkiPrompt({ id: "p5", showcaseImages: ["broken", { after: A, before: B }] });
    expect(prompt.art.url).toBe(A);
    expect(prompt.before).toBe(B);
  });

  it("showcaseImages wins over previewImages when both are present", () => {
    const prompt = mapMarketplacePromptToEnkiPrompt({ id: "p6", previewImages: [{ url: A2 }], showcaseImages: [{ after: A, before: B }] });
    expect(prompt.art.url).toBe(A);
    expect(prompt.before).toBe(B);
  });
});
