/**
 * A referred link: a post on a social site that a user sends in ("Refer a
 * prompt") so a moderator can rebuild it as a prompt. One reading of such a
 * link for the dialog and for the server.
 */

/** The platforms the queue accepts (hunt_submissions_source_platform_check, probed live 2026-10-05). */
export type ReferralPlatform = "x" | "instagram" | "tiktok" | "other";

/** What a platform is called on screen; a site the queue has no name for is a plain link. */
export const REFERRAL_PLATFORM_NAME: Record<ReferralPlatform, string> = { x: "X", instagram: "Instagram", tiktok: "TikTok", other: "Link" };

export interface ReferralLink {
  /** The link as a browser opens it: what is stored, shown to a moderator and clicked. */
  url: string;
  /** The same post however it was copied: what a duplicate is recognised by. */
  normalized: string;
  platform: ReferralPlatform;
}

const MAX_LENGTH = 2000;
const of = (host: string, domain: string) => host === domain || host.endsWith("." + domain);

function platformOf(host: string): ReferralPlatform {
  if (of(host, "x.com") || of(host, "twitter.com")) return "x";
  if (of(host, "instagram.com")) return "instagram";
  if (of(host, "tiktok.com")) return "tiktok";
  return "other";
}

/*
 * Where a site names a post by an id, the id alone is the post: the handle in
 * front of it, /photo/1 behind it, /p/ or /reel/ are all the same post. Each
 * pattern is anchored so that only a post matches; any other page of the site
 * (a profile, an audio page, a short link that hides the id) keeps its path.
 */
const POST: Partial<Record<ReferralPlatform, { id: RegExp; as: string }>> = {
  x: { id: /\/status(?:es)?\/(\d+)(?:\/|$)/, as: "x.com/status/" },
  instagram: { id: /^\/(?:[^/]+\/)?(?:p|reels?|tv)\/([\w-]+)$/, as: "instagram.com/p/" },
  tiktok: { id: /\/(?:video|photo|v)\/(\d+)(?:\.html)?$/, as: "tiktok.com/video/" },
};

/**
 * A link that may go into the queue, or null. A moderator opens it from the
 * admin panel, so it must be a link a browser reads the same way the server
 * does:
 * - written out with http:// or https://. "https:x.com/…" parses as a link to
 *   x.com here, but inside a page a browser reads it as a path on that page's
 *   own site; and anything else (javascript:, data:) would run there.
 * - without a user name in front of the host, which makes
 *   "https://x.com@evil.example" look like x.com.
 * - to a host with a dot, and not endless.
 */
export function parseReferralLink(raw: unknown): ReferralLink | null {
  if (typeof raw !== "string") return null;
  const sent = raw.trim();
  if (!sent || sent.length > MAX_LENGTH) return null;
  if (!/^https?:\/\//i.test(sent)) return null;
  let parsed: URL;
  try {
    parsed = new URL(sent);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) return null;
  const platform = platformOf(host);
  const path = parsed.pathname.replace(/\/+$/, "");
  // The parsed form, not the text that was typed: a host in another script is
  // then stored and shown in its plain (punycode) spelling.
  const url = parsed.href;

  const post = POST[platform];
  const id = post && path.match(post.id);
  if (post && id) return { url, normalized: post.as + id[1], platform };

  // twitter.com and x.com are one site, and so are their mobile hosts.
  const site = platform === "x" ? "x.com" : host;
  // On the three known sites the query is tracking (?s=20, ?igshid=); elsewhere
  // it can be the post itself (youtube.com/watch?v=), so it stays.
  const query = platform === "other" ? parsed.search : "";
  return { url, normalized: site + path + query, platform };
}
