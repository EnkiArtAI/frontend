import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { serverUrls } from "@/lib/creations";
import { historyForPrompt, type GenerationRow } from "@/lib/ui/image-view/history";

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
});

it("My Gallery and the current history exclude a queued original or preview", () => {
  const gallery = readSource(join(__dirname, "..", "..", "app", "my-gallery", "page.tsx"));
  expect(gallery).toMatch(/const dbUrls = serverUrls\(generations\);/);
  const row: GenerationRow = { ...ROW, id: "row", thumbnail_url: null, isUploaded: false, visibility: "private", prompt_id: "prompt", created_at: "" };
  expect(historyForPrompt([row], "prompt", [])).toEqual([row]);
  for (const imageUrl of [ROW.image_url, ROW.image_urls[0]]) expect(historyForPrompt([row], "prompt", [{ imageUrl }])).toEqual([]);
});
