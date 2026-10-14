import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/session-headers", () => ({ viewerHeaders: () => ({}) }));
import { listBookmarks, listCategories } from "@/hooks/useBookmarks";
afterEach(() => vi.unstubAllGlobals());

it("passes the query's abort signal to both category and paginated bookmark requests", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ categories: [], bookmarks: [], nextCursor: null }) }));
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  await listCategories(signal);
  await listBookmarks("category", 60, 60, signal);
  expect(fetcher).toHaveBeenNthCalledWith(1, "/api/bookmarks/categories", { headers: { "Content-Type": "application/json" }, signal });
  expect(fetcher).toHaveBeenNthCalledWith(2, "/api/bookmarks?category=category&cursor=60&limit=60", { headers: { "Content-Type": "application/json" }, signal });
});
