/**
 * Comments and ratings share one table (prompt_comments): a row is a comment,
 * a rating, or both. GET /api/prompts/[id]/comments returns the newest 100 and
 * cannot page (plan §5 #20), so a full read makes every count "at least".
 */
import { failureSentence } from "@/lib/search/client";

/** One row of GET /api/prompts/[id]/comments. */
export interface CommentRow {
  id: string;
  /** "anonymous" when the author has no handle. */
  handle: string;
  rating: number | null;
  body: string | null;
  createdAt: string;
}

/** The most rows the route returns. */
export const DISCUSSION_CAP = 100;

export interface Discussion {
  /** Rows without a rating (each has text: the route takes a rating, a text, or both): the Comments tab. */
  comments: CommentRow[];
  /** Every rating, with its text when it has one: the Reviews tab. */
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
  const rated = (r: CommentRow) => typeof r.rating === "number";
  const avg = j.stats?.avgRating;
  return {
    comments: rows.filter((r) => !rated(r)),
    reviews: rows.filter(rated),
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
