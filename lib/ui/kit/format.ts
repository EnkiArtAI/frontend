/** Small text helpers of the Image View: times, file names, avatar letters. */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * How long ago `at` was, against an injected `now` (never read in render).
 *   short (comments): now · 5m · 2h · 1d · 3w
 *   long (history):   just now · 5m ago · 2h ago · yesterday · 3d ago · 3w ago
 * From five weeks on, both give the date ("Aug 9"), with the year when it is not this year.
 */
export function formatAgo(at: string | number, now: number, style: "short" | "long" = "long"): string {
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return "";
  const ms = now - t;
  const short = style === "short";
  if (ms >= 5 * WEEK) {
    const d = new Date(t);
    const year = d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year });
  }
  const ago = (unit: number, mark: string) => `${Math.floor(ms / unit)}${mark}${short ? "" : " ago"}`;
  if (ms < MIN) return short ? "now" : "just now";
  if (ms < HOUR) return ago(MIN, "m");
  if (ms < DAY) return ago(HOUR, "h");
  if (ms < 2 * DAY && !short) return "yesterday";
  if (ms < WEEK) return ago(DAY, "d");
  return ago(WEEK, "w");
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** "misty-harbor-3.webp": the title as a slug, the image's number, and the extension its type names (webp otherwise). */
export function downloadName(title: string, n: number, mime: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "enki";
  return `${slug}-${n}.${EXT[mime] ?? "webp"}`;
}

/** An avatar's two letters: "amara.dev" → "AM"; "?" when the handle has none. */
export const initials = (handle: string) => handle.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";
