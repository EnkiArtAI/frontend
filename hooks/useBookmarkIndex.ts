"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listBookmarks, listCategories } from "@/hooks/useBookmarks";
import { readBookmarkIndex, type BookmarkIndex } from "@/lib/ui/feed/bookmark-index";

export const BOOKMARK_INDEX_KEY = ["bookmark-index"];
/** The route's page ceiling, and at most 10 pages: 600 bookmarks known for
    1 + 10 GETs a session. Past that a card shows as unsaved. */
const PAGE = 60;
const MAX_PAGES = 10;

const readIndex = () =>
  readBookmarkIndex({ categories: listCategories, page: (id, cursor) => listBookmarks(id, cursor, PAGE) }, PAGE, MAX_PAGES)
    // Signed out or not migrated: nothing shows as saved, and the picker says why.
    .catch((): BookmarkIndex => new Map());

/**
 * Which prompts the viewer has bookmarked, and where: read once a session,
 * at idle once `enabled` (the feed's first page is up), so it never delays
 * the wall. BookmarkPicker patches it in place after an add or a remove.
 */
export function useBookmarkIndex(enabled: boolean): BookmarkIndex | undefined {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!enabled || idle) return;
    const go = () => setIdle(true);
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(go, { timeout: 3000 });
      return () => cancelIdleCallback(id);
    }
    const t = setTimeout(go, 1000);
    return () => clearTimeout(t);
  }, [enabled, idle]);
  return useQuery({ queryKey: BOOKMARK_INDEX_KEY, queryFn: readIndex, enabled: enabled && idle, staleTime: Infinity }).data;
}
