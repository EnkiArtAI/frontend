/** The card's "★ 4.8 (312)", from GET /api/prompts/[id]/comments. */
export interface CardRating { avg: string; count: string; title: string }

/** The route answers the newest 100 rows; a full page means there are more. */
const PAGE = 100;

/**
 * The rating a card shows, or null when there is none: no "–", no "0.0".
 * The server's average when it sends one, else the mean of the ratings read.
 * A full page adds "+" to the count, and the title says the average covers
 * only the latest ratings.
 */
export function ratingSummary(body: unknown): CardRating | null {
  const b = (body && typeof body === "object" ? body : {}) as { comments?: unknown; stats?: { avgRating?: unknown } };
  if (!Array.isArray(b.comments)) return null;
  const ratings = b.comments
    .map((c) => (c && typeof c === "object" ? (c as { rating?: unknown }).rating : null))
    .filter((r): r is number => typeof r === "number" && Number.isFinite(r));
  if (!ratings.length) return null;
  const stated = b.stats?.avgRating;
  const avg = (typeof stated === "number" && Number.isFinite(stated) ? stated : ratings.reduce((s, r) => s + r, 0) / ratings.length).toFixed(1);
  const n = ratings.length;
  const capped = b.comments.length >= PAGE;
  return {
    avg,
    count: capped ? `${n}+` : String(n),
    title: `${avg} from ${capped ? "the latest " : ""}${n} rating${n === 1 ? "" : "s"}`,
  };
}
