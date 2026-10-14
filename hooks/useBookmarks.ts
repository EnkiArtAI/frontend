"use client";

/**
 * Client API for bookmarks — the card picker and the Bookmarks panel both
 * talk through here, so the request shapes live in exactly one place.
 */
import { viewerHeaders } from "@/lib/session-headers";

export type BookmarkCategory = { id: string; name: string; count: number; logoUrl: string | null; createdAt: string };
export type Bookmark = { id: string; promptId: string; imageUrl: string | null; position: number };

const HEADERS = () => ({ "Content-Type": "application/json", ...viewerHeaders() });

export async function listCategories(signal?: AbortSignal): Promise<BookmarkCategory[]> {
  const res = await fetch("/api/bookmarks/categories", { headers: HEADERS(), signal });
  if (!res.ok) {
    // The status travels with the error so the UI can say the real thing:
    // 401 = sign in; 503 = the migration has not been run yet.
    const err = new Error("categories unavailable") as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()).categories;
}

/** The honest sentence for a failed bookmarks call. */
export function bookmarksProblem(e: unknown): string {
  const status = (e as { status?: number })?.status;
  if (status === 401) return "Sign in to use bookmarks.";
  if (status === 503) return "Bookmarks aren't set up yet (database migration pending).";
  return "Bookmarks are unavailable right now.";
}

export async function createCategory(name: string): Promise<BookmarkCategory> {
  const res = await fetch("/api/bookmarks/categories", { method: "POST", headers: HEADERS(), body: JSON.stringify({ name }) });
  const d = await res.json().catch(() => ({}));
  // 409 = the name already exists; the picker treats that as "use it".
  if (!res.ok && res.status !== 409) throw new Error(d.error || "couldn't create");
  return { count: 0, logoUrl: null, ...d.category };
}

export async function addBookmark(categoryId: string, promptId: string, imageUrl?: string | null): Promise<Bookmark> {
  const res = await fetch("/api/bookmarks", {
    method: "POST", headers: HEADERS(),
    body: JSON.stringify({ categoryId, promptId, ...(imageUrl ? { imageUrl } : {}) }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || "couldn't bookmark");
  return d.bookmark;
}

export async function listBookmarks(categoryId: string, cursor?: number | null, limit?: number, signal?: AbortSignal): Promise<{ bookmarks: Bookmark[]; nextCursor: number | null }> {
  const q = new URLSearchParams({ category: categoryId });
  if (cursor != null) q.set("cursor", String(cursor));
  if (limit) q.set("limit", String(limit));
  const res = await fetch(`/api/bookmarks?${q}`, { headers: HEADERS(), signal });
  if (!res.ok) throw new Error("bookmarks unavailable");
  return await res.json();
}

export async function moveBookmark(id: string, position: number): Promise<void> {
  const res = await fetch("/api/bookmarks", { method: "PATCH", headers: HEADERS(), body: JSON.stringify({ id, position }) });
  if (!res.ok) throw new Error("couldn't move");
}

export async function removeBookmark(id: string): Promise<void> {
  const res = await fetch(`/api/bookmarks?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: HEADERS() });
  if (!res.ok) throw new Error("couldn't remove");
}
