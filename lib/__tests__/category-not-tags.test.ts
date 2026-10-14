import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { mapMarketplacePromptToEnkiPrompt } from "../enkiPromptAdapter";
import { ENKI_CATEGORIES } from "../../components/enki/EnkiFilters";

/**
 * prompts.tags is ours now (automatic search tags, Kev 2026-10-07), so the
 * editor's one category no longer travels in it: the editor saves it as
 * prompts.category, and the feed's category chips filter on that.
 */

const ROOT = join(__dirname, "..", "..");

describe("the category", () => {
  it("is read from prompts.category, lowercased like the chips", () => {
    const p = mapMarketplacePromptToEnkiPrompt({ id: "p1", title: "Brass", category: "Photography", tags: ["brass", "still life"] });
    expect(p.category).toBe("photography");
    expect(mapMarketplacePromptToEnkiPrompt({ id: "p2", title: "None" }).category).toBe("");
  });

  it("is what the feed's chips filter on, any picked chip matching", () => {
    const feed = readSource(join(ROOT, "components", "enki", "EnkiFeedPage.tsx"));
    expect(feed).toMatch(/return allPrompts\.filter\(\(prompt\) => tags\.includes\(prompt\.category\)\);/);
    expect(feed).not.toMatch(/prompt\.tags\.includes\(tag\)/);
  });

  it("offers Kev's list of 2026-10-13, in his order, More last", () => {
    expect([...ENKI_CATEGORIES]).toEqual(["Marketing", "Portrait", "Influencers", "Product", "Architecture", "Characters", "Branding", "More"]);
  });
});

it("the current release body sends category and no tags", () => {
  const body = readSource(join(ROOT, "lib", "editor", "release.ts"));
  expect(body).toContain('category: listing.category ?? "",');
  expect(body).not.toMatch(/\btags:/);
});
