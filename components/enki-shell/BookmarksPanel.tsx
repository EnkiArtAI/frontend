"use client";

/**
 * The Bookmarks tab (Kev, 2026-08-22): all categories as a grid — each
 * wearing its FIRST bookmark as the logo — and inside a category every
 * bookmark in order, read page by page. The bookmarks show exactly like
 * Home's wall (Kev, 2026-10-13: "the same view on there like on home"): the
 * feed's cards, a tap opens the image view beside the menu, and the card's
 * own bookmark button takes it out of the category again. The back arrow
 * sits top-left, leaves when reading scrolls down, and a brief scroll UP
 * brings it back.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bookmark, Loader2 } from "lucide-react";
import PromptWall from "@/components/enki/PromptWall";
import { useBookmarkIndex } from "@/hooks/useBookmarkIndex";
import {
  listCategories, listBookmarks, bookmarksProblem,
  type Bookmark as Mark, type BookmarkCategory,
} from "@/hooks/useBookmarks";
import "@/components/enki/bookmarks.css";

export default function BookmarksPanel() {
  const [cats, setCats] = useState<BookmarkCategory[] | null>(null);
  const [open, setOpen] = useState<BookmarkCategory | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    listCategories().then(setCats).catch((e) => { setCats([]); setFailed(bookmarksProblem(e)); });
  }, []);

  /* Epoch guard: entering a category invalidates every response still in
     flight for the previous one — without it a slow first page of category
     A landed on top of category B (found by review, 2026-08-22). */
  const epochRef = useRef(0);
  const loadMore = useCallback(async (cat: BookmarkCategory, cur: number | null) => {
    const epoch = epochRef.current;
    setLoading(true);
    try {
      const page = await listBookmarks(cat.id, cur);
      if (epoch !== epochRef.current) return;
      setMarks((m) => (cur == null ? page.bookmarks : [...m, ...page.bookmarks]));
      setCursor(page.nextCursor);
      if (page.nextCursor == null) setDone(true);
    } catch {
      if (epoch !== epochRef.current) return;
      setFailed("Couldn't load more right now.");
      setDone(true); // stop the sentinel — otherwise it retries in a tight loop
    } finally {
      if (epoch === epochRef.current) setLoading(false);
    }
  }, []);

  const enter = (cat: BookmarkCategory) => {
    epochRef.current += 1;
    setOpen(cat); setMarks([]); setCursor(null); setDone(false); setFailed(null);
    void loadMore(cat, null);
  };
  const back = () => { epochRef.current += 1; setOpen(null); setMarks([]); listCategories().then(setCats).catch(() => {}); };
  const more = useCallback(() => {
    if (open && !loading && cursor != null) void loadMore(open, cursor);
  }, [open, loading, cursor, loadMore]);

  /* A bookmark the card's own button took out of this category leaves the
     wall at once (the session's bookmark index follows the picker). */
  const index = useBookmarkIndex(open !== null);
  const ids = marks
    .filter((m) => !index || (index.get(m.promptId) ?? []).some((x) => x.categoryId === open?.id))
    .map((m) => m.promptId);

  /* The back arrow: visible at the top, gone once reading scrolls down, back
     the moment the reader scrolls up even briefly. */
  const rootRef = useRef<HTMLDivElement>(null);
  const [arrowIn, setArrowIn] = useState(true);
  const lastY = useRef(0);
  const onScroll = () => {
    const y = rootRef.current?.scrollTop ?? 0;
    setArrowIn(y < 24 || y < lastY.current);
    lastY.current = y;
  };

  if (!open) {
    return (
      <div className="enki-bm-root" ref={rootRef}>
        {cats === null && <div className="enki-bm-note"><Loader2 size={14} className="enki-bmp-spin" /> Loading…</div>}
        {failed && <div className="enki-bm-note">{failed}</div>}
        {cats?.length === 0 && !failed && (
          <div className="enki-bm-note">
            <Bookmark size={15} /> Nothing saved yet — tap the bookmark on any image to start a category.
          </div>
        )}
        <div className="enki-bm-cats">
          {cats?.map((c) => (
            <button key={c.id} type="button" className="enki-bm-cat" onClick={() => enter(c)}>
              {c.logoUrl ? <img src={c.logoUrl} alt="" draggable={false} /> : <span className="enki-bm-cat-empty"><Bookmark size={18} /></span>}
              <span className="enki-bm-cat-name">{c.name}</span>
              <span className="enki-bm-cat-count mono">{c.count}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="enki-bm-root" ref={rootRef} onScroll={onScroll}>
      <button type="button" className={"enki-bm-back" + (arrowIn ? "" : " enki-bm-back--out")} onClick={back} aria-label="Back to categories">
        <ArrowLeft size={16} /> {open.name}
      </button>
      <PromptWall ids={ids} loading={loading && marks.length === 0} more={!done} onMore={more}
        note={<div className="enki-bm-note"><Bookmark size={15} /> Nothing in this category any more.</div>} />
      {loading && marks.length > 0 && <div className="enki-bm-note"><Loader2 size={14} className="enki-bmp-spin" /> Loading…</div>}
      {failed && <div className="enki-bm-note">Couldn't load more right now.</div>}
    </div>
  );
}
