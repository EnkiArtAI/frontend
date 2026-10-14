/** Where a prompt is bookmarked: one entry per category that holds it. */
export interface Membership { bookmarkId: string; categoryId: string }
export type BookmarkIndex = ReadonlyMap<string, readonly Membership[]>;

/**
 * How many pages of each category to read: every page, in category order,
 * until `maxPages` is spent. What lies past the budget stays unknown, so
 * those cards show as unsaved rather than as a guess.
 */
export function planBookmarkReads(
  categories: readonly { id: string; count: number }[],
  pageSize: number,
  maxPages: number,
): { id: string; pages: number }[] {
  let left = maxPages;
  return categories
    .map(({ id, count }) => {
      const pages = Math.min(Math.ceil(Math.max(0, count) / pageSize), left);
      left -= pages;
      return { id, pages };
    })
    .filter((p) => p.pages > 0);
}

/** The pages read, as prompt id → the categories holding it. */
export function indexBookmarks(
  read: readonly { categoryId: string; bookmarks: readonly { id: string; promptId: string }[] }[],
): BookmarkIndex {
  const index = new Map<string, Membership[]>();
  for (const { categoryId, bookmarks } of read) {
    for (const b of bookmarks) index.set(b.promptId, [...(index.get(b.promptId) ?? []), { bookmarkId: b.id, categoryId }]);
  }
  return index;
}

/** The index from the bookmark routes: the categories, then each planned
 *  category's pages in parallel, one after another within a category. */
export async function readBookmarkIndex(
  api: {
    categories: () => Promise<readonly { id: string; count: number }[]>;
    page: (categoryId: string, cursor: number | null) => Promise<{ bookmarks: readonly { id: string; promptId: string }[]; nextCursor: number | null }>;
  },
  pageSize: number,
  maxPages: number,
): Promise<BookmarkIndex> {
  const plan = planBookmarkReads(await api.categories(), pageSize, maxPages);
  return indexBookmarks(await Promise.all(plan.map(async ({ id, pages }) => {
    const bookmarks: { id: string; promptId: string }[] = [];
    let cursor: number | null = null;
    for (let i = 0; i < pages; i++) {
      const page = await api.page(id, cursor);
      bookmarks.push(...page.bookmarks);
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    return { categoryId: id, bookmarks };
  })));
}

/** A new index with `m` added (one per category: the server's add is idempotent). */
export function withMembership(index: BookmarkIndex, promptId: string, m: Membership): BookmarkIndex {
  const next = new Map(index);
  next.set(promptId, [...(index.get(promptId) ?? []).filter((x) => x.categoryId !== m.categoryId), m]);
  return next;
}

/** A new index without that bookmark. */
export function withoutMembership(index: BookmarkIndex, promptId: string, bookmarkId: string): BookmarkIndex {
  const next = new Map(index);
  const left = (index.get(promptId) ?? []).filter((m) => m.bookmarkId !== bookmarkId);
  if (left.length) next.set(promptId, left);
  else next.delete(promptId);
  return next;
}
