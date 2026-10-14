import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The viewer's own lists — likes, bookmarks and their categories — show 18+
 * only while the pill is on (and the viewer confirmed), and always show the
 * viewer's own 18+ prompts (found by review, 2026-10-03).
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private filters: ((r: Row) => boolean)[] = [];
  private cap = Infinity;
  private one = false;
  constructor(private table: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  gt(c: string, v: number) { this.filters.push((r) => Number(r[c]) > v); return this; }
  order() { return this; }
  limit(n: number) { this.cap = n; return this; }
  maybeSingle() { this.one = true; return this; }
  then<A, B = never>(ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
    const rows = (tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r))).slice(0, this.cap);
    return Promise.resolve({ data: this.one ? rows[0] ?? null : rows, error: null as null }).then(ok, ko);
  }
}
const fake = { from: (t: string) => new Query(t) };
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => fake }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async (_s: unknown, t: string | null) => (t === "tok" ? "me" : null) }));

import { GET as likes } from "../../app/api/prompts/likes/mine/route";
import { GET as bookmarks } from "../../app/api/bookmarks/route";
import { GET as categories } from "../../app/api/bookmarks/categories/route";

const req = (path: string, pill = false) => new NextRequest(`http://enki.test${path}`, {
  headers: { "X-Session-Token": "tok", ...(pill ? { "X-Show-Adult": "1" } : {}) },
});

beforeEach(() => {
  tables = {
    users: [{ id: "me", adult_confirmed_at: "2026-10-03T10:00:00Z" }],
    prompts: [
      { id: "plain", title: "Plain", is_adult: false, creator_id: "other", showcase_images: [] },
      { id: "theirs", title: "Theirs", is_adult: true, creator_id: "other", showcase_images: [] },
      { id: "mine", title: "Mine", is_adult: true, creator_id: "me", showcase_images: [] },
    ],
    reactions: ["plain", "theirs", "mine"].map((id) => ({ user_id: "me", target_type: "prompt", reaction_type: "like", target_uuid: id, created_at: "2026-10-03" })),
    bookmarks: ["plain", "theirs", "mine"].map((id, i) => ({ id: `b-${id}`, user_id: "me", category_id: "c1", prompt_id: id, image_url: `https://img/${id}.png`, position: i })),
    bookmark_categories: [{ id: "c1", name: "Saved", user_id: "me", created_at: "2026-10-01" }],
  };
});

const liked = async (pill = false) => ((await (await likes(req("/api/prompts/likes/mine", pill))).json()).likes as Row[]).map((l) => l.promptId);
const marked = async (pill = false) => ((await (await bookmarks(req("/api/bookmarks?category=c1", pill))).json()).bookmarks as Row[]).map((b) => b.promptId);
const shelf = async (pill = false) => ((await (await categories(req("/api/bookmarks/categories", pill))).json()).categories as Row[])[0];

describe("likes", () => {
  it("leave out others' 18+ while the pill is off, keep the viewer's own", async () => {
    expect(await liked()).toEqual(["plain", "mine"]);
  });

  it("show everything with the pill on", async () => {
    expect(await liked(true)).toEqual(["plain", "theirs", "mine"]);
  });

  it("ignore the pill without a confirmation", async () => {
    tables.users[0].adult_confirmed_at = null;
    expect(await liked(true)).toEqual(["plain", "mine"]);
  });
});

describe("bookmarks", () => {
  it("leave out others' 18+ while the pill is off, keep the viewer's own", async () => {
    expect(await marked()).toEqual(["plain", "mine"]);
  });

  it("show everything with the pill on", async () => {
    expect(await marked(true)).toEqual(["plain", "theirs", "mine"]);
  });
});

describe("bookmark categories", () => {
  it("neither count nor show others' 18+ as the logo while the pill is off", async () => {
    tables.bookmarks[0].position = 9; // the 18+ bookmark comes first
    tables.bookmarks.sort((a, b) => Number(a.position) - Number(b.position));
    expect(await shelf()).toMatchObject({ count: 2 });
    expect((await shelf()).logoUrl).not.toBe("https://img/theirs.png");
  });

  it("count everything with the pill on", async () => {
    expect(await shelf(true)).toMatchObject({ count: 3 });
  });
});

describe("the clients", () => {
  const ROOT = join(__dirname, "..", "..");
  const src = (...p: string[]) => readSource(join(ROOT, ...p));

  it("send the pill on these reads", () => {
    expect(src("hooks", "useBookmarks.ts")).toMatch(/const HEADERS = \(\) => \(\{ "Content-Type": "application\/json", \.\.\.viewerHeaders\(\) \}\);/);
    const profile = src("components", "profile", "ProfileView.tsx");
    expect(profile).toMatch(/fetch\("\/api\/prompts\/likes\/mine", \{ headers: viewerHeaders\(\) \}\)/);
    expect(profile).toMatch(/\/profile`, \{ headers: viewerHeaders\(\) \}\);/);
    expect(src("components", "image-view", "useOwnRenders.ts")).toContain("{ headers: viewerHeaders() }");
  });

  it("dice answer an 18+ prompt like a missing one to anyone who may not see it", () => {
    expect(src("app", "api", "workflow", "variables", "route.ts"))
      .toMatch(/if \(prompt\?\.is_adult && !mayShowAdult\(await viewer\(supabase, req\), prompt\.creator_id as string \| null\)\) \{\n\s+return NextResponse\.json\(\{ error: "Could not load the prompt" \}, \{ status: 404 \}\);/);
  });
});
