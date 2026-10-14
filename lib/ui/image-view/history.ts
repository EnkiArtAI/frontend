/**
 * The buyer's own renders of this prompt. GET /api/generations has no prompt
 * filter (plan §5 #15), so the rows are read 100 at a time and filtered here.
 * A render the queue still shows is listed too (Kev, 2026-10-13: the rail is
 * where a fresh render lands); the model folds the two into one shot.
 */
import { serverUrls } from "@/lib/creations";
import type { Job } from "@/lib/ui/kit/render-queue";

/** One row of GET /api/generations (app/api/generations/route.ts). */
export interface GenerationRow {
  /** generated_images.id, what PATCH /api/images/[id] and a report take. */
  id: string;
  /** The stored original (downloads). */
  image_url: string | null;
  /** What galleries display: the WebP preview when there is one, else the original. */
  image_urls: string[];
  thumbnail_url: string | null;
  isUploaded: boolean;
  visibility: "public" | "private";
  prompt_id: string | null;
  /** What the render was made with (the generation row); null for an upload or a row from before the route sent it. */
  settings?: { modelId: string | null; aspectRatio: string | null; resolution: string | null; boost: boolean } | null;
  created_at: string;
}

export interface GenerationsPage {
  generations: GenerationRow[];
  /** Every row the owner has, not only this prompt's. */
  total: number;
}

/** The most rows the route returns at once. */
export const HISTORY_PAGE = 100;

/** One page of the viewer's rows; read with viewerHeaders(), or the owner's private rows are not theirs. */
export const generationsUrl = (userKey: string, offset: number) =>
  `/api/generations?userId=${encodeURIComponent(userKey)}&limit=${HISTORY_PAGE}&offset=${offset}`;

/** A page as the route answers it: { generations, total } at the top level (createSuccessResponse), never under `data`. */
export function readGenerations(json: unknown): GenerationsPage {
  const j = (json ?? {}) as { generations?: unknown; total?: unknown };
  return {
    generations: Array.isArray(j.generations) ? (j.generations as GenerationRow[]) : [],
    total: typeof j.total === "number" ? j.total : 0,
  };
}

/** Where "Load older" reads next, or undefined once every row is in (useInfiniteQuery's getNextPageParam). */
export function nextOffset(pages: GenerationsPage[]): number | undefined {
  const last = pages[pages.length - 1];
  const read = pages.length * HISTORY_PAGE;
  return last && last.generations.length === HISTORY_PAGE && read < last.total ? read : undefined;
}

/**
 * This prompt's renders among the rows read, in the server's order (newest
 * first): no uploads, none without an image, each row once (a page read after
 * a new render repeats the row the render pushed over). The blank composer
 * has none.
 */
export function historyForPrompt(rows: GenerationRow[], promptId: string | null): GenerationRow[] {
  if (!promptId) return [];
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (r.prompt_id !== promptId || r.isUploaded || seen.has(r.id)) return false;
    seen.add(r.id);
    return serverUrls([r]).size > 0;
  });
}

/** The recorded row behind a render's URL, once a read has it: its id carries the Public switch (plan §5 #23). Uploads never go public. */
export const recordOf = (rows: GenerationRow[], url: string) => rows.find((r) => !r.isUploaded && serverUrls([r]).has(url));

/**
 * The public images made with a prompt, as the strip shows them after the
 * creator's examples. One of the viewer's own (made public in the History) is
 * the viewer's history entry itself: it stands there as the next example, and
 * picking it loads the settings it was made with, like anywhere else (Kev,
 * 2026-10-13). Anyone else's becomes `other(image)`.
 */
export function publicShots<S extends { record?: GenerationRow }, I extends { url: string }>(
  images: I[], rows: GenerationRow[], history: S[], other: (image: I) => S,
): S[] {
  return images.map((im) => {
    const mine = recordOf(rows, im.url);
    return (mine && history.find((h) => h.record?.id === mine.id)) || other(im);
  });
}

/** Whether a finished render is still missing from the rows, so the read asks again (every 3 s, for at most 60 s). */
export function unrecorded(jobs: Pick<Job<unknown>, "imageUrl">[], rows: GenerationRow[]): boolean {
  const known = serverUrls(rows);
  return jobs.some((j) => !!j.imageUrl && !known.has(j.imageUrl));
}

/** The comment and review composers open once the buyer has an image of this prompt: one in the queue or in its history (checked here only, plan §5 #19). */
export const hasGenerated = (jobs: Pick<Job<unknown>, "status">[], history: GenerationRow[]) =>
  history.length > 0 || jobs.some((j) => j.status === "ready");
