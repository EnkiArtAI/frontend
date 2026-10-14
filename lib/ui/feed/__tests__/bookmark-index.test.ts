import { describe, expect, it } from "vitest";
import { indexBookmarks, planBookmarkReads, readBookmarkIndex, withMembership, withoutMembership } from "../bookmark-index";

const cats = (...counts: number[]) => counts.map((count, i) => ({ id: `c${i}`, count }));

describe("planBookmarkReads", () => {
  it("reads every page of every category within the budget", () => {
    expect(planBookmarkReads(cats(10, 130, 0), 60, 10)).toEqual([{ id: "c0", pages: 1 }, { id: "c1", pages: 3 }]);
  });
  it("stops at the budget, in category order", () => {
    const plan = planBookmarkReads(cats(400, 400, 60), 60, 10);
    expect(plan).toEqual([{ id: "c0", pages: 7 }, { id: "c1", pages: 3 }]);
    expect(plan.reduce((n, p) => n + p.pages, 0)).toBe(10);
  });
  it("plans nothing for no categories", () => {
    expect(planBookmarkReads([], 60, 10)).toEqual([]);
  });
});

describe("readBookmarkIndex", () => {
  /** Fake routes: each category holds `count` bookmarks of prompts `${cat}-${n}`, 60 a page. */
  function routes(counts: number[]) {
    const calls: string[] = [];
    const api = {
      categories: async () => { calls.push("categories"); return cats(...counts); },
      page: async (categoryId: string, cursor: number | null) => {
        calls.push(`${categoryId}@${cursor}`);
        const count = counts[Number(categoryId.slice(1))];
        const from = cursor ?? 0;
        const to = Math.min(count, from + 60);
        const bookmarks = Array.from({ length: to - from }, (_, i) => ({ id: `${categoryId}-b${from + i}`, promptId: `${categoryId}-${from + i}` }));
        return { bookmarks, nextCursor: to < count ? to : null };
      },
    };
    return { api, calls };
  }

  it("walks each category's pages by cursor and indexes what it read", async () => {
    const { api, calls } = routes([130, 5]);
    const index = await readBookmarkIndex(api, 60, 10);
    expect(calls).toEqual(["categories", "c0@null", "c1@null", "c0@60", "c0@120"]);
    expect(index.size).toBe(135);
    expect(index.get("c0-129")).toEqual([{ bookmarkId: "c0-b129", categoryId: "c0" }]);
  });

  it("asks at most 1 + 10 times, however many bookmarks there are", async () => {
    const { api, calls } = routes([400, 400, 60]);
    const index = await readBookmarkIndex(api, 60, 10);
    expect(calls).toHaveLength(11);
    expect(calls.filter((c) => c.startsWith("c2"))).toEqual([]);
    // c0 whole (400 in 7 pages), c1's first 3 pages (180).
    expect(index.size).toBe(580);
  });

  it("stops a category early when the route says there is no more", async () => {
    const { api, calls } = routes([30]);
    // The categories row claims 130; the route ends after the first page.
    api.categories = async () => { calls.push("categories"); return cats(130); };
    await readBookmarkIndex(api, 60, 10);
    expect(calls).toEqual(["categories", "c0@null"]);
  });
});

describe("the index", () => {
  const index = indexBookmarks([
    { categoryId: "c0", bookmarks: [{ id: "b1", promptId: "p1" }, { id: "b2", promptId: "p2" }] },
    { categoryId: "c1", bookmarks: [{ id: "b3", promptId: "p1" }] },
  ]);

  it("knows every category a prompt sits in", () => {
    expect(index.get("p1")).toEqual([{ bookmarkId: "b1", categoryId: "c0" }, { bookmarkId: "b3", categoryId: "c1" }]);
    expect(index.get("p2")).toEqual([{ bookmarkId: "b2", categoryId: "c0" }]);
    expect(index.has("p3")).toBe(false);
  });

  it("adds a membership into a new index, once per category", () => {
    const added = withMembership(index, "p2", { bookmarkId: "b4", categoryId: "c1" });
    expect(added.get("p2")).toEqual([{ bookmarkId: "b2", categoryId: "c0" }, { bookmarkId: "b4", categoryId: "c1" }]);
    expect(withMembership(added, "p2", { bookmarkId: "b4", categoryId: "c1" }).get("p2")).toHaveLength(2);
    expect(index.get("p2")).toHaveLength(1);
  });

  it("removes a membership into a new index, and the prompt with its last one", () => {
    const less = withoutMembership(index, "p1", "b1");
    expect(less.get("p1")).toEqual([{ bookmarkId: "b3", categoryId: "c1" }]);
    expect(withoutMembership(less, "p1", "b3").has("p1")).toBe(false);
    expect(index.get("p1")).toHaveLength(2);
  });
});
