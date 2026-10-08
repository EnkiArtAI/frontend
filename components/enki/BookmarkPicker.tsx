"use client";

/**
 * The popup behind a card's bookmark button (Kev, 2026-08-22): every
 * category listed, "create new category" AT THE TOP; that opens a minimal
 * name field where Enter or Create files the bookmark into the fresh
 * category. Picking an existing category files it there directly; a
 * category that already holds the prompt shows ✓, and picking it removes
 * the prompt from there.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Check, Loader2 } from "lucide-react";
import { listCategories, createCategory, addBookmark, removeBookmark, bookmarksProblem, type BookmarkCategory } from "@/hooks/useBookmarks";
import { BOOKMARK_INDEX_KEY } from "@/hooks/useBookmarkIndex";
import { withMembership, withoutMembership, type BookmarkIndex, type Membership } from "@/lib/ui/feed/bookmark-index";
import { placeMenu } from "@/lib/ui/kit/controls";
import "@/components/enki/bookmarks.css";

/** The tallest the picker gets: it opens above its button when this does not fit below. */
const PICKER_H = 300;

export default function BookmarkPicker({ promptId, imageUrl, onClose, anchor, memberships = [], onChange }: {
  promptId: string;
  imageUrl?: string | null;
  onClose: () => void;
  /** The button's box. Given, the picker floats in a portal beside it,
   *  clear of any card that clips; without it, it sits in its parent. */
  anchor?: DOMRect;
  /** The categories that already hold this prompt. */
  memberships?: readonly Membership[];
  onChange?: (kind: "added" | "removed", categoryName: string) => void;
}) {
  const queryClient = useQueryClient();
  const [cats, setCats] = useState<BookmarkCategory[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [savingTo, setSavingTo] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listCategories().then(setCats).catch((e) => { setCats([]); setFailed(bookmarksProblem(e)); });
  }, []);

  // Beside the button, right-aligned, inside the viewport; placed before paint.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!anchor || !el) return;
    const at = placeMenu(
      { left: anchor.right - el.offsetWidth, top: anchor.top, bottom: anchor.bottom },
      { width: el.offsetWidth, height: PICKER_H },
      { width: window.innerWidth, height: window.innerHeight },
    );
    Object.assign(el.style, {
      left: `${at.left}px`,
      top: at.top === undefined ? "" : `${at.top}px`,
      bottom: at.bottom === undefined ? "" : `${at.bottom}px`,
    });
  }, [anchor]);

  // Outside press / ESC close — capture, so the card's own link never fires.
  // A press on the anchoring button is left to the button, which toggles.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      if (anchor && e.clientX >= anchor.left && e.clientX <= anchor.right && e.clientY >= anchor.top && e.clientY <= anchor.bottom) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    // A floating picker would drift off its card when the page scrolls.
    if (anchor) window.addEventListener("scroll", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onClose);
    };
  }, [onClose, anchor]);

  // The feed's bookmark index follows in place, without a refetch.
  const patchIndex = (f: (index: BookmarkIndex) => BookmarkIndex) =>
    queryClient.setQueryData<BookmarkIndex>(BOOKMARK_INDEX_KEY, (index) => index && f(index));

  const saveInto = async (cat: BookmarkCategory) => {
    if (savingTo) return;
    setSavingTo(cat.id);
    try {
      const b = await addBookmark(cat.id, promptId, imageUrl);
      patchIndex((index) => withMembership(index, promptId, { bookmarkId: b.id, categoryId: cat.id }));
      setSavedTo(cat.id);
      onChange?.("added", cat.name);
      window.setTimeout(onClose, 650); // let the check register, then leave
    } catch (e) {
      setSavingTo(null);
      setFailed(bookmarksProblem(e));
    }
  };

  const removeFrom = async (cat: BookmarkCategory, m: Membership) => {
    if (savingTo) return;
    setSavingTo(cat.id);
    try {
      await removeBookmark(m.bookmarkId);
      patchIndex((index) => withoutMembership(index, promptId, m.bookmarkId));
      setCats((cs) => cs && cs.map((c) => (c.id === cat.id ? { ...c, count: Math.max(0, c.count - 1) } : c)));
      onChange?.("removed", cat.name);
    } catch (e) {
      setFailed(bookmarksProblem(e));
    }
    setSavingTo(null);
  };

  const createAndSave = async () => {
    const n = name.trim();
    if (!n || savingTo) return;
    try {
      const cat = await createCategory(n);
      await saveInto(cat);
    } catch (e) {
      setFailed(bookmarksProblem(e));
    }
  };

  const picker = (
    <div ref={rootRef} className={"enki-bmp" + (anchor ? " enki-bmp--float" : "")} onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {creating ? (
        <div className="enki-bmp-create">
          <input
            autoFocus value={name} maxLength={60} placeholder="Category name…"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createAndSave(); }}
          />
          <button type="button" className="enki-bmp-go" disabled={!name.trim()} onClick={createAndSave}>Create</button>
        </div>
      ) : (
        <button type="button" className="enki-bmp-row enki-bmp-new" onClick={() => setCreating(true)}>
          <Plus size={13} /> Create new category
        </button>
      )}
      <div className="enki-bmp-list">
        {cats === null && <div className="enki-bmp-note"><Loader2 size={13} className="enki-bmp-spin" /> Loading…</div>}
        {cats?.length === 0 && !failed && <div className="enki-bmp-note">No categories yet — create one above.</div>}
        {failed && <div className="enki-bmp-note">{failed}</div>}
        {cats?.map((c) => {
          const m = memberships.find((x) => x.categoryId === c.id);
          return (
            <button key={c.id} type="button" className="enki-bmp-row" disabled={!!savingTo} aria-pressed={Boolean(m)}
              title={m ? `Remove from ${c.name}` : undefined} onClick={() => (m ? removeFrom(c, m) : saveInto(c))}>
              {c.logoUrl
                ? <img src={c.logoUrl} alt="" className="enki-bmp-logo" draggable={false} />
                : <span className="enki-bmp-logo enki-bmp-logo-empty" />}
              <span className="enki-bmp-name">{c.name}</span>
              {savedTo === c.id || m
                ? <Check size={13} className="enki-bmp-ok" />
                : <span className="enki-bmp-count mono">{c.count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
  return anchor ? createPortal(picker, document.body) : picker;
}
