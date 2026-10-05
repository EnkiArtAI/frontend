import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { parseReferralLink } from "@/lib/referral-link";

/**
 * "Refer a prompt" (Kev, 2026-10-05): the dialog stores the link in the
 * moderators' queue. It used to keep it in the browser, so the queue the admin
 * panel reads stayed empty.
 */

type Row = Record<string, unknown>;
let queue: Row[];
let unique = false;
// The duplicate lookup answers "none", as it does for a row another request is just writing.
let lookupBlind = false;
let failing: "select" | "insert" | "unreachable" | null = null;

/** Returns only the selected columns, applies its filters and its order, as PostgREST does. */
class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: ((r: Row) => boolean)[] = [];
  private cols: string[] | null = null;
  private row: Row | null = null;
  private sort: { col: string; ascending: boolean } | null = null;
  select(c: string) { this.cols = c.split(",").map((x) => x.trim()); return this; }
  insert(r: Row) { this.row = r; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  order(col: string, o: { ascending: boolean }) { this.sort = { col, ascending: o.ascending }; return this; }
  limit() { return this; }
  then<A, B = never>(ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
    const answer = (): { data: unknown; error: unknown } => {
      // What supabase-js hands back when the database host cannot be reached.
      if (failing === "unreachable") return { data: null, error: { message: "TypeError: fetch failed" } };
      if (this.row) {
        if (failing === "insert") return { data: null, error: { message: "insert refused" } };
        // The table's own guard against two entries for one post, when it has one.
        if (unique && queue.some((r) => r.normalized_source_url === this.row!.normalized_source_url)) return { data: null, error: { code: "23505", message: "duplicate key" } };
        queue.push({ id: `h${queue.length + 1}`, status: "pending", minted_prompt_id: null, submitted_at: `2026-10-05T10:00:0${queue.length}.000Z`, ...this.row });
        return { data: null, error: null };
      }
      if (failing === "select") return { data: null, error: { message: "select refused" } };
      if (lookupBlind) return { data: [], error: null };
      const cols = this.cols ?? [];
      const hits = queue.filter((r) => this.filters.every((f) => f(r)));
      const sort = this.sort;
      if (sort) hits.sort((a, b) => String(a[sort.col]).localeCompare(String(b[sort.col])) * (sort.ascending ? 1 : -1));
      return { data: hits.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))), error: null };
    };
    return Promise.resolve(answer()).then(ok, ko);
  }
}

const SESSIONS: Record<string, { userId: string | null; ban: { id: string } | null }> = {
  ana: { userId: "u-ana", ban: null },
  ben: { userId: "u-ben", ban: null },
  banned: { userId: "u-banned", ban: { id: "b1" } },
};
const limit = vi.fn((..._a: unknown[]): { allowed: true } | { allowed: false; retryAfterSeconds: number } => ({ allowed: true }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from: () => new Query() }) }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserWithBan: async (_s: unknown, t: string | null) => SESSIONS[t ?? ""] ?? { userId: null, ban: null } }));
vi.mock("@/lib/rate-limit", async (original) => ({ ...(await original<typeof import("@/lib/rate-limit")>()), checkRequestRateLimit: (...a: unknown[]) => limit(...a) }));

import { GET, POST } from "../../app/api/referrals/route";

const send = (url: unknown, token: string | null = "ana") => POST(new NextRequest("http://enki.test/api/referrals", {
  method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-Session-Token": token } : {}) }, body: JSON.stringify({ url }),
}));
const mine = (token: string | null = "ana") => GET(new NextRequest("http://enki.test/api/referrals", { headers: token ? { "X-Session-Token": token } : {} }));

beforeEach(() => {
  queue = [];
  unique = false;
  lookupBlind = false;
  failing = null;
  limit.mockReset();
  limit.mockReturnValue({ allowed: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a link that is sent in", () => {
  it("lands in the moderators' queue with who sent it, waiting for review", async () => {
    const res = await send("https://x.com/artist/status/123?s=20");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(queue).toEqual([expect.objectContaining({
      hunter_user_id: "u-ana", source_url: "https://x.com/artist/status/123?s=20", normalized_source_url: "x.com/status/123", source_platform: "x", status: "pending",
    })]);
  });

  it.each([
    ["https://twitter.com/artist/status/1", "x"],
    ["https://mobile.twitter.com/artist/status/1", "x"],
    ["https://www.instagram.com/p/CxYz12/", "instagram"],
    ["https://vm.tiktok.com/ZM8abc/", "tiktok"],
    ["https://www.youtube.com/watch?v=abc", "other"],
    ["https://pinterest.com/pin/1", "other"],
    // A host that only ends like a known one is not that site.
    ["https://notx.com/artist/status/1", "other"],
  ])("is filed under a platform the queue accepts: %s", async (url, platform) => {
    expect((await send(url)).status).toBe(201);
    expect(queue[0].source_platform).toBe(platform);
  });

  it("is refused without an account, and for a suspended one", async () => {
    expect((await send("https://x.com/a/status/1", null)).status).toBe(401);
    expect((await send("https://x.com/a/status/1", "nobody")).status).toBe(401);
    expect((await send("https://x.com/a/status/1", "banned")).status).toBe(401);
    expect(queue).toEqual([]);
  });

  it.each([
    ["nothing", ""],
    ["no link", "great art, look it up"],
    ["a link without a host", "https://localhost/post"],
    ["a host that ends in a dot", "https://x.com./artist/status/1"],
    ["no text at all", 42],
    ["an endless link", "https://x.com/" + "a".repeat(2000)],
    // Each of these names a real host, so only the rule on the protocol refuses it.
    ["a script that carries a host", "javascript://x.com/%0Aalert(1)"],
    ["a data link that carries a host", "data://x.com/x"],
    ["an app link", "intent://x.com/artist"],
    ["another protocol", "ftp://x.com/artist"],
    ["a script without a host", "javascript:alert(1)//x.com"],
    // Read here as a link to x.com, but as a path on its own site by the page a moderator clicks it in.
    ["a link with one slash missing", "https:/x.com/artist/status/1"],
    ["a link with both slashes missing", "https:x.com/artist/status/1"],
    ["a link that would open a page of the app itself", "https:x.com/a/status/1/../../../../gate?next=javascript:alert(1)"],
    ["an http link without its slashes", "http:x.com/artist/status/1"],
    // Everything before the @ is a user name; the host is the other site.
    ["a link that names x.com as a user of another site", "https://x.com@evil.example/artist/status/1"],
    ["a link with a password in it", "https://artist:secret@x.com/artist/status/1"],
  ])("is refused when it is %s", async (_name, url) => {
    const res = await send(url);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Enter the full link to the post, starting with https://");
    expect(queue).toEqual([]);
  });

  it("is stored as a browser opens it, a host in another script in its plain spelling", async () => {
    // A Cyrillic "х" reads as x.com on screen; stored and shown it is xn--….
    expect((await send("https://х.com/artist/status/1")).status).toBe(201);
    expect(String(queue[0].source_url).startsWith("https://xn--")).toBe(true);
    expect(queue[0].source_platform).toBe("other");
    expect((await send("HTTPS://X.com/Artist/status/7")).status).toBe(201);
    expect(queue[1].source_url).toBe("https://x.com/Artist/status/7");
  });

  it("is refused while the sender sends too many: ten in ten minutes, counted per account", async () => {
    await send("https://x.com/a/status/1");
    expect(limit).toHaveBeenCalledWith("referrals:submit:u-ana", 10, 600_000);
    limit.mockReturnValue({ allowed: false, retryAfterSeconds: 30 });
    expect((await send("https://x.com/a/status/2")).status).toBe(429);
    expect(queue).toHaveLength(1);
  });

  it("answers an error, not a success, when the queue cannot be written", async () => {
    failing = "insert";
    const res = await send("https://x.com/a/status/1");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("The link could not be sent in. Try again.");
  });

  it("is not stored blind when the queue cannot be read for duplicates", async () => {
    failing = "select";
    expect((await send("https://x.com/a/status/1")).status).toBe(500);
    expect(queue).toEqual([]);
  });

  it("says the service is unavailable when the database cannot be reached", async () => {
    failing = "unreachable";
    expect((await send("https://x.com/a/status/1")).status).toBe(503);
    expect((await mine()).status).toBe(503);
  });
});

describe("a post that is already in the queue", () => {
  it.each([
    ["the same link", "https://x.com/artist/status/123"],
    ["with tracking in the link", "https://x.com/artist/status/123?s=20&t=abc"],
    ["with a trailing slash", "https://x.com/artist/status/123/"],
    ["under the site's other name", "https://twitter.com/artist/status/123"],
    ["with www and http", "http://www.x.com/artist/status/123"],
    ["copied from the opened image", "https://x.com/artist/status/123/photo/1"],
    ["copied without the handle", "https://x.com/i/status/123"],
    ["with the handle written another way", "https://x.com/Artist/status/123"],
    ["from the old address form", "https://twitter.com/artist/statuses/123"],
  ])("is refused, whoever sends it: %s", async (_name, url) => {
    expect((await send("https://x.com/artist/status/123", "ben")).status).toBe(201);
    const res = await send(url);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This link was already sent in.");
    expect(queue).toHaveLength(1);
  });

  it.each([
    ["an Instagram post with tracking", "https://www.instagram.com/p/CxYz12/", "https://instagram.com/p/CxYz12?igshid=abc"],
    ["an Instagram post opened as a reel", "https://www.instagram.com/p/CxYz12/", "https://www.instagram.com/reel/CxYz12/"],
    ["an Instagram post under its account's name", "https://www.instagram.com/p/CxYz12/", "https://www.instagram.com/artist/p/CxYz12/"],
    ["a TikTok video with tracking", "https://www.tiktok.com/@a/video/73", "https://www.tiktok.com/@a/video/73?is_from_webapp=1"],
    ["a TikTok video on the mobile site", "https://www.tiktok.com/@a/video/73", "https://m.tiktok.com/v/73.html"],
  ])("is recognised on the other sites too: %s", async (_name, first, again) => {
    expect((await send(first, "ben")).status).toBe(201);
    expect((await send(again)).status).toBe(409);
    expect(queue).toHaveLength(1);
  });

  it.each([
    ["a profile under the site's other name", "https://x.com/artist", "https://twitter.com/artist"],
    ["a profile with tracking", "https://x.com/artist", "https://x.com/artist?s=20"],
    ["a short link with tracking", "https://vm.tiktok.com/ZM8abc/", "https://vm.tiktok.com/ZM8abc/?k=1"],
  ])("is recognised for a page that is no post as well: %s", async (_name, first, again) => {
    expect((await send(first, "ben")).status).toBe(201);
    expect((await send(again)).status).toBe(409);
    expect(queue).toHaveLength(1);
  });

  it("is recognised with and without www on any site", async () => {
    expect((await send("https://www.pinterest.com/pin/1")).status).toBe(201);
    expect((await send("https://pinterest.com/pin/1")).status).toBe(409);
    expect(queue.map((r) => r.normalized_source_url)).toEqual(["pinterest.com/pin/1"]);
  });

  it("is another post when its id or its path differs, also only in case", async () => {
    const posts = [
      "https://x.com/artist/status/123",
      "https://x.com/artist/status/124",
      // Instagram's post codes tell upper from lower case.
      "https://instagram.com/p/CxYz12",
      "https://instagram.com/p/cxyz12",
      "https://www.tiktok.com/@a/video/73",
      "https://www.tiktok.com/@a/video/74",
      "https://www.youtube.com/watch?v=abc",
      "https://www.youtube.com/watch?v=xyz",
      // Pages that are no post keep their whole path: two audio pages, two profiles, two short links.
      "https://www.instagram.com/reels/audio/1111",
      "https://www.instagram.com/reels/audio/2222",
      "https://x.com/artist",
      "https://x.com/another",
      "https://vm.tiktok.com/ZM8abc/",
      "https://vm.tiktok.com/ZM8xyz/",
    ];
    for (const url of posts) expect((await send(url)).status).toBe(201);
    expect(new Set(queue.map((r) => r.normalized_source_url)).size).toBe(posts.length);
  });

  it("is refused the same way when the database itself keeps the second one out", async () => {
    // Two people send one post at once: the second lookup still sees nothing, the table's key does.
    unique = true;
    expect((await send("https://x.com/artist/status/5", "ben")).status).toBe(201);
    lookupBlind = true;
    const res = await send("https://x.com/artist/status/5");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This link was already sent in.");
    expect(queue).toHaveLength(1);
  });
});

describe("the links someone sent in", () => {
  it("are theirs alone, the newest first", async () => {
    await send("https://x.com/a/status/1", "ana");
    await send("https://instagram.com/p/Abc", "ben");
    await send("https://x.com/a/status/2", "ana");
    const res = await mine("ana");
    expect(res.status).toBe(200);
    expect((await res.json()).referrals).toEqual([
      { id: "h3", url: "https://x.com/a/status/2", platform: "x", status: "pending", promptId: null, submittedAt: "2026-10-05T10:00:02.000Z" },
      { id: "h1", url: "https://x.com/a/status/1", platform: "x", status: "pending", promptId: null, submittedAt: "2026-10-05T10:00:00.000Z" },
    ]);
  });

  it("are not read without an account, nor by a suspended one", async () => {
    expect((await mine(null)).status).toBe(401);
    expect((await mine("banned")).status).toBe(401);
  });
});

describe("reading a referred link", () => {
  it("gives the link as a browser opens it and recognises the post however it was copied", () => {
    expect(parseReferralLink("  https://www.x.com/Artist/status/9/?s=20#top  ")).toEqual({ url: "https://www.x.com/Artist/status/9/?s=20#top", normalized: "x.com/status/9", platform: "x" });
    expect(parseReferralLink("https://example.com")).toEqual({ url: "https://example.com/", normalized: "example.com", platform: "other" });
    expect(parseReferralLink("https://www.instagram.com/artist/reel/CxYz-_12/")?.normalized).toBe("instagram.com/p/CxYz-_12");
    expect(parseReferralLink("https://www.tiktok.com/@a/photo/73")?.normalized).toBe("tiktok.com/video/73");
  });
});
