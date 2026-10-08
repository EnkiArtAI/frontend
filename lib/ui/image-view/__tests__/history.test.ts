import { describe, it, expect } from "vitest";
import {
  generationsUrl, hasGenerated, historyForPrompt, nextOffset, readGenerations, recordOf, unrecorded,
  type GenerationRow, type GenerationsPage,
} from "../history";

const row = (id: string, over: Partial<GenerationRow> = {}): GenerationRow => ({
  id, image_url: `https://blob/${id}.png`, image_urls: [`https://blob/${id}.preview.webp`], thumbnail_url: null,
  isUploaded: false, visibility: "private", prompt_id: "p1", created_at: "2026-10-09T10:00:00Z", ...over,
});
const page = (n: number, total: number): GenerationsPage => ({ generations: Array.from({ length: n }, (_, i) => row(`r${i}`)), total });

describe("reading the rows", () => {
  it("asks for 100 rows of the viewer's key at an offset", () => {
    expect(generationsUrl("So1/ana+", 200)).toBe("/api/generations?userId=So1%2Fana%2B&limit=100&offset=200");
  });

  it("reads the route's top-level answer, and nothing from a body without one", () => {
    expect(readGenerations({ generations: [row("a")], total: 7, limit: 100, offset: 0 })).toEqual({ generations: [row("a")], total: 7 });
    expect(readGenerations({ data: { generations: [row("a")], total: 7 } })).toEqual({ generations: [], total: 0 });
    expect(readGenerations(null)).toEqual({ generations: [], total: 0 });
  });

  it("pages 100 at a time until every row is in", () => {
    expect(nextOffset([])).toBeUndefined();
    expect(nextOffset([page(100, 250)])).toBe(100);
    expect(nextOffset([page(100, 250), page(100, 250)])).toBe(200);
    expect(nextOffset([page(100, 250), page(100, 250), page(50, 250)])).toBeUndefined();
    expect(nextOffset([page(100, 100)])).toBeUndefined();
    // A short page ends the reading even when the total says more.
    expect(nextOffset([page(99, 250)])).toBeUndefined();
  });
});

describe("historyForPrompt", () => {
  it("keeps this prompt's renders in the server's order, without uploads or rows without an image", () => {
    const rows = [
      row("a"), row("other", { prompt_id: "p2" }), row("up", { isUploaded: true }),
      row("bare", { image_url: null, image_urls: [] }), row("b"), row("none", { prompt_id: null }),
    ];
    expect(historyForPrompt(rows, "p1", []).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("lists a row once when a later page repeats it", () => {
    expect(historyForPrompt([row("a"), row("b"), row("a")], "p1", []).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("leaves out a render the queue still shows, by its original and by its preview", () => {
    const rows = [row("a"), row("b"), row("c")];
    const jobs = [{ imageUrl: "https://blob/a.png" }, { imageUrl: "https://blob/b.preview.webp" }, { imageUrl: undefined }];
    expect(historyForPrompt(rows, "p1", jobs).map((r) => r.id)).toEqual(["c"]);
  });

  it("is empty in the blank composer", () => {
    expect(historyForPrompt([row("a", { prompt_id: null })], null, [])).toEqual([]);
  });
});

describe("a fresh render's record", () => {
  const rows = [row("up", { isUploaded: true, image_url: "https://blob/x.png" }), row("a")];

  it("recordOf finds the row by the render's original or preview, never an upload", () => {
    expect(recordOf(rows, "https://blob/a.png")?.id).toBe("a");
    expect(recordOf(rows, "https://blob/a.preview.webp")?.id).toBe("a");
    expect(recordOf(rows, "https://blob/x.png")).toBeUndefined();
  });

  it("unrecorded asks again while a finished render is not in the rows", () => {
    expect(unrecorded([{ imageUrl: "https://blob/a.png" }, { imageUrl: "https://blob/new.png" }], rows)).toBe(true);
    expect(unrecorded([{ imageUrl: "https://blob/a.preview.webp" }, { imageUrl: undefined }], rows)).toBe(false);
  });
});

describe("hasGenerated", () => {
  it("is a ready render in the queue or one in this prompt's history", () => {
    expect(hasGenerated([{ status: "ready" }], [])).toBe(true);
    expect(hasGenerated([], [row("a")])).toBe(true);
    expect(hasGenerated([{ status: "failed" }, { status: "rendering" }], [])).toBe(false);
  });
});
