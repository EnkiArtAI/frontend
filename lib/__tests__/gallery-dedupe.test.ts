import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { serverUrls } from "@/lib/creations";

/**
 * A render the server recorded is shown once. The browser keeps the URL the
 * route answered with (the stored original); the gallery row displays its
 * WebP preview. Matching on the displayed URL alone showed every such render
 * twice in My Gallery and in the generator's history.
 */

const ROW = { image_url: "https://abc.public.blob.vercel-storage.com/generations/u/1.png", image_urls: ["https://abc.public.blob.vercel-storage.com/generations/u/1.preview.webp"] };

describe("a recorded render", () => {
  it("is known by its original and by its preview", () => {
    const urls = serverUrls([ROW, { image_url: null, image_urls: [] }]);
    expect([...urls].sort()).toEqual([ROW.image_url, ROW.image_urls[0]].sort());
  });

  it("is matched on both in My Gallery and in the generator's history", () => {
    const gallery = readSource(join(__dirname, "..", "..", "app", "my-gallery", "page.tsx"));
    expect(gallery).toMatch(/const dbUrls = serverUrls\(generations\);/);
    const view = readSource(join(__dirname, "..", "..", "components", "PromptGeneratorView.tsx"));
    expect(view).toMatch(/const recorded = serverUrls\(genData\?\.data\?\.generations \?\? genData\?\.generations \?\? \[\]\);/);
    expect(view).toContain("...localHistory.filter(url => !recorded.has(url))");
  });
});
