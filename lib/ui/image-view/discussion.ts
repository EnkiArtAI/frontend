/**
 * Comments and reviews share one table (prompt_comments): a comment is text
 * from anyone signed in; a review carries one of the reviewer's own images
 * made with the prompt (Kev, 2026-10-13), with a rating and text if they
 * like. GET /api/prompts/[id]/comments returns the newest 100 and cannot page
 * (plan §5 #20), so a full read makes every count "at least".
 */
import { failureSentence } from "@/lib/search/client";

/** One row of GET /api/prompts/[id]/comments. */
export interface CommentRow {
  id: string;
  /** "anonymous" when the author has no handle. */
  handle: string;
  rating: number | null;
  body: string | null;
  /** The reviewer's image; null on a comment, and on a review whose image is gone. */
  imageUrl?: string | null;
  createdAt: string;
}

/** The most rows the route returns. */
export const DISCUSSION_CAP = 100;

export interface Discussion {
  /** Rows with neither an image nor a rating (each has text): the Comments tab. */
  comments: CommentRow[];
  /** Every row with an image or a rating (ratings from before reviews carried images count): the Reviews tab. */
  reviews: CommentRow[];
  /** Every row with text, rated or not: the phone's one list (it has no Reviews tab). */
  written: CommentRow[];
  /** The server's average over the rows it returned; null without a rating (the rating is then not shown). */
  avgRating: number | null;
  /** The read hit the cap: counts read "n+". */
  capped: boolean;
}

export function readDiscussion(json: unknown): Discussion {
  const j = (json ?? {}) as { comments?: unknown; stats?: { avgRating?: unknown } };
  const rows = Array.isArray(j.comments) ? (j.comments as CommentRow[]) : [];
  const review = (r: CommentRow) => typeof r.rating === "number" || !!r.imageUrl;
  const avg = j.stats?.avgRating;
  return {
    comments: rows.filter((r) => !review(r)),
    reviews: rows.filter(review),
    written: rows.filter((r) => r.body),
    avgRating: typeof avg === "number" ? avg : null,
    capped: rows.length >= DISCUSSION_CAP,
  };
}

/** A count as the tabs and the rating show it: "12", or "100+" once the read hit the cap. */
export const countLabel = (n: number, capped: boolean) => `${n}${capped ? "+" : ""}`;

/**
 * The read, or why it failed: the server's own sentence, else "The feedback
 * could not load (HTTP n).", and a lost connection says so. It throws, so a
 * failed read keeps the last good list under the reason and is never shown
 * as "No comments yet".
 */
export async function loadDiscussion(promptId: string, get: typeof fetch = fetch): Promise<Discussion> {
  let res: Response;
  try {
    res = await get(`/api/prompts/${encodeURIComponent(promptId)}/comments`);
  } catch {
    throw new Error("The feedback could not load. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(await failureSentence(res, "The feedback could not load"));
  return readDiscussion(await res.json().catch(() => null));
}

/**
 * The prompt's likes (GET /api/prompts/[id]/likes). A failed read throws: the
 * query is then an error and asks again on the next open, where a cached
 * "nothing" would keep the heart disabled.
 */
export async function loadLikes(promptId: string, headers: HeadersInit, get: typeof fetch = fetch): Promise<{ count: number; mine: boolean }> {
  const res = await get(`/api/prompts/${encodeURIComponent(promptId)}/likes`, { headers });
  if (!res.ok) throw new Error(`The likes could not load (HTTP ${res.status})`);
  const d = (await res.json()) as { count?: unknown; mine?: unknown } | null;
  return { count: Number(d?.count) || 0, mine: !!d?.mine };
}
