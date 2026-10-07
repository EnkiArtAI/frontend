import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { readSource } from "./_read-source";
import { PROMPT_CARD_SELECT, mapPromptRow } from "../marketplace/card";
import { isSearchNotMigrated, SEARCH_NOT_MIGRATED_MESSAGE } from "../search/db";

/**
 * /api/search and /api/search/suggest: the RPCs from
 * migrations/2026-09-24-search.sql, loaded as the marketplace card. What
 * these tests hold: the card mapper is the one the feed uses, no encrypted
 * column is ever selected on the way, a missing migration is a 503 with one
 * sentence, and the routes are gated and rate limited like the feed.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").split("\r\n").join("\n");

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => holder.client }));

type Result = { data: unknown; error: unknown };

/** A supabase-js shaped fake: rpc() answers from `rpc`, from(table) resolves to `tables[table]`. */
function fakeSupabase(rpc: (fn: string, args: Record<string, unknown>) => Result, tables: Record<string, unknown[]> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const rows = tables[table] ?? [];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "in", "is", "order", "eq"]) q[m] = () => q;
    q.single = async () => ({ data: rows[0] ?? null, error: null });
    q.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    return q;
  };
  holder.client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return rpc(fn, args);
    },
    from,
  };
  return calls;
}

let ip = 0;
const get = (path: string) =>
  new NextRequest(`http://enki.test${path}`, { headers: { "x-real-ip": `10.0.0.${++ip}` } });

const row = {
  id: "0d8c1e7e-1b2c-4d3e-8f90-123456789abc",
  title: "Dragon over Kyoto",
  public_prompt_text: "A dragon circling the pagoda at golden hour",
  price_usd_cents: 250,
  category: "fantasy",
  tags: ["dragon", "kyoto", "golden hour"],
  ai_model: "nano-banana-pro",
  created_at: "2026-09-24T10:00:00.000Z",
  creator_id: "a1b2c3d4-0000-4000-8000-000000000001",
  showcase_images: ["https://img/1.png", "https://img/2.png"],
  aspect_ratio: "16:9",
  resolution: "4k",
  is_free_showcase: false,
  prompt_type: "paid",
  description: "The artist's own words about it",
};

describe("lib/marketplace/card", () => {
  it("maps a prompts row exactly as the marketplace feed does, a paid prompt's text withheld", () => {
    expect(mapPromptRow(row)).toEqual({
      id: "0d8c1e7e-1b2c-4d3e-8f90-123456789abc",
      title: "Dragon over Kyoto",
      description: "The artist's own words about it",
      promptTemplate: "",
      priceUsdCents: 250,
      category: "fantasy",
      tags: ["dragon", "kyoto", "golden hour"],
      totalSales: 0,
      avgRating: 0,
      createdAt: "2026-09-24T10:00:00.000Z",
      listedAt: "2026-09-24T10:00:00.000Z",
      userId: "a1b2c3d4-0000-4000-8000-000000000001",
      previewImages: [{ url: "https://img/1.png" }, { url: "https://img/2.png" }],
      showcaseImages: [{ url: "https://img/1.png" }, { url: "https://img/2.png" }],
      aiModel: "nano-banana-pro",
      model: "nano-banana-pro",
      aspectRatio: "16:9",
      resolution: "4k",
      isFreeShowcase: false,
      promptType: "paid",
      isVideo: false,
    });
    expect(mapPromptRow({ ...row, price_usd_cents: null, tags: null, showcase_images: null, public_prompt_text: null, description: null })).toMatchObject({
      priceUsdCents: 0, tags: [], previewImages: [], description: "", promptTemplate: "",
    });
  });

  it("shows a free prompt's excerpt", () => {
    expect(mapPromptRow({ ...row, prompt_type: "free" })).toMatchObject({
      description: "A dragon circling the pagoda at golden hour",
      promptTemplate: "A dragon circling the pagoda at golden hour",
    });
  });

  it("is the mapper the marketplace route uses", () => {
    const src = readSource(join(ROOT, "app", "api", "marketplace", "prompts", "route.ts"));
    expect(src).toMatch(/from "@\/lib\/marketplace\/card"/);
    expect(src).toMatch(/\.select\(PROMPT_CARD_SELECT\)/);
    expect(src).toMatch(/dbPrompts\.map\(mapPromptRow\)/);
    expect(src).toMatch(/await enrichPromptCards\(/);
    // No second copy of the column list or the shape may grow back here.
    expect(src).not.toMatch(/public_prompt_text/);
    expect(src).not.toMatch(/previewImages:/);
  });
});

describe("no encrypted column reaches search", () => {
  const ENCRYPTED = /encrypted|_iv\b|_tag\b|_kid\b|email_/;

  it("the card select carries only public columns", () => {
    expect(PROMPT_CARD_SELECT).not.toMatch(ENCRYPTED);
    expect(PROMPT_CARD_SELECT).toMatch(/^id,title,description,public_prompt_text,/);
  });

  it("neither route nor the card module names an encrypted column", () => {
    for (const p of [
      ["app", "api", "search", "route.ts"],
      ["app", "api", "search", "suggest", "route.ts"],
      ["lib", "marketplace", "card.ts"],
    ]) {
      expect(readSource(join(ROOT, ...p)), p.join("/")).not.toMatch(ENCRYPTED);
    }
  });

  it("the SQL functions select no encrypted or email column", () => {
    const sql = read("migrations", "2026-09-24-search.sql").replace(/--[^\n]*/g, "");
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION search_prompts\(q text, lim int, off int, show_adult boolean DEFAULT false\)/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION suggest_titles\(q text, lim int, show_adult boolean DEFAULT false\)/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION search_creators\(q text, lim int, show_adult boolean DEFAULT false\)/);
    expect(sql).not.toMatch(ENCRYPTED);
    // The index too: title, description, tags and nothing else.
    expect(sql).toMatch(/coalesce\(title, ''\) \|\| ' ' \|\| coalesce\(description, ''\) \|\| ' ' \|\| coalesce\(tags_to_text\(tags\), ''\)/);
    expect((sql.match(/STABLE SECURITY INVOKER/g) ?? []).length).toBe(3);
  });
});

describe("the SQL functions hide banned creators and users who never published", () => {
  const sql = read("migrations", "2026-09-24-search.sql").replace(/--[^\n]*/g, "");
  const fn = (name: string) => {
    const m = sql.match(new RegExp("CREATE OR REPLACE FUNCTION " + name + "\\([\\s\\S]*?\\n\\$\\$;"));
    expect(m, name).not.toBeNull();
    return m![0];
  };
  const BAN = /AND NOT EXISTS \(SELECT 1 FROM bans b\s+WHERE b\.user_id = (p\.creator_id|u\.id)\s+AND b\.lifted_at IS NULL\s+AND \(b\.expires_at IS NULL OR b\.expires_at > now\(\)\)\)/;

  it.each([
    ["search_prompts", "p.creator_id"],
    ["suggest_titles", "p.creator_id"],
    ["search_creators", "u.id"],
  ])("%s excludes a creator with an unlifted, unexpired ban", (name, owner) => {
    const m = fn(name).match(BAN);
    expect(m, name).not.toBeNull();
    expect(m![1]).toBe(owner);
  });

  it("search_creators lists only users with a listed, active, undeleted prompt", () => {
    expect(fn("search_creators")).toMatch(
      /AND EXISTS \(SELECT 1 FROM prompts p\s+WHERE p\.creator_id = u\.id\s+AND p\.is_listed = true\s+AND p\.deleted_at IS NULL\s+AND p\.listing_status = 'active'\s+AND \(show_adult OR p\.is_adult = false\)\)/,
    );
  });
});

describe("GET /api/search", () => {
  beforeEach(() => { holder.client = null; });

  it("answers 503 with one sentence while the migration is not applied", async () => {
    const { GET } = await import("../../app/api/search/route");
    // The exact PostgREST answer recorded live on 2026-09-24.
    fakeSupabase(() => ({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.search_prompts(lim, off, q) in the schema cache",
      },
    }));
    const res = await GET(get("/api/search?q=dragon"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: SEARCH_NOT_MIGRATED_MESSAGE, code: "SEARCH_NOT_MIGRATED" });
  });

  it("maps a missing column the same way, and nothing else", async () => {
    expect(isSearchNotMigrated({ code: "42703", message: "column prompts.search_tsv does not exist" })).toBe(true);
    expect(isSearchNotMigrated({ code: "42883" })).toBe(true);
    expect(isSearchNotMigrated({ code: "22P02", message: "invalid input syntax" })).toBe(false);
    expect(isSearchNotMigrated(new Error("PGRST202"))).toBe(false);

    const { GET } = await import("../../app/api/search/route");
    fakeSupabase(() => ({ data: null, error: { code: "22P02", message: "invalid input syntax for type integer" } }));
    const res = await GET(get("/api/search?q=dragon"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Search failed" });
  });

  it("returns the ranked prompts as marketplace cards, in rank order, with a cursor", async () => {
    const { GET } = await import("../../app/api/search/route");
    const a = { ...row, id: "a" };
    const b = { ...row, id: "b", title: "Dragon" };
    const c = { ...row, id: "c" };
    const calls = fakeSupabase(
      (fn) => fn === "search_prompts"
        ? { data: [{ id: "b", rank: 0.9 }, { id: "a", rank: 0.5 }, { id: "c", rank: 0.1 }], error: null }
        : { data: [{ id: "u1", handle: "kev", display_name: null, avatar_url: null }], error: null },
      { prompts: [a, c, b], users: [{ id: "u1", handle: "kev", display_name: "Kev", avatar_url: "https://img/k.png" }] },
    );
    const res = await GET(get("/api/search?q=dragon&limit=2&type=all"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(calls[0]).toEqual({ fn: "search_prompts", args: { q: "dragon", lim: 3, off: 0, show_adult: false } });
    expect(body.prompts.map((p: { id: string }) => p.id)).toEqual(["b", "a"]);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe("2");
    expect(body.prompts[0]).toMatchObject({
      id: "b",
      title: "Dragon",
      priceUsdCents: 250,
      creator: { id: "u1", handle: "kev", username: "kev", displayName: "Kev", avatarUrl: "https://img/k.png" },
      variables: [],
      previewImages: [{ url: "https://img/1.png" }, { url: "https://img/2.png" }],
    });
    expect(calls[1]).toEqual({ fn: "search_creators", args: { q: "dragon", lim: 8, show_adult: false } });
    expect(body.creators).toEqual([{ id: "u1", handle: "kev", displayName: "kev", avatarUrl: null }]);
  });

  it("type=creators skips the prompt RPC, the cursor continues at the offset, the limit is capped at 40", async () => {
    const { GET } = await import("../../app/api/search/route");
    let calls = fakeSupabase(() => ({ data: [], error: null }));
    const res = await GET(get("/api/search?q=kev&type=creators&limit=100"));
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.fn)).toEqual(["search_creators"]);
    expect(calls[0].args).toEqual({ q: "kev", lim: 40, show_adult: false });

    calls = fakeSupabase(() => ({ data: [], error: null }));
    await GET(get("/api/search?q=kev&type=prompts&limit=100&cursor=80"));
    expect(calls).toEqual([{ fn: "search_prompts", args: { q: "kev", lim: 41, off: 80, show_adult: false } }]);
    const empty = await (await GET(get("/api/search?q=kev&type=prompts"))).json();
    expect(empty).toEqual({ query: "kev", prompts: [], creators: [], hasMore: false });
  });

  it("refuses a missing q or an unknown type before touching the database", async () => {
    const { GET } = await import("../../app/api/search/route");
    const calls = fakeSupabase(() => { throw new Error("must not be called"); });
    expect((await GET(get("/api/search?q=%20"))).status).toBe(400);
    expect((await GET(get("/api/search?q=dragon&type=users"))).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("GET /api/search/suggest", () => {
  it("asks for 8 titles and 4 creators and maps both", async () => {
    const { GET } = await import("../../app/api/search/suggest/route");
    const calls = fakeSupabase((fn) => fn === "suggest_titles"
      ? { data: [{ id: "p1", title: "Dragon over Kyoto", extra: "dropped" }], error: null }
      : { data: [{ id: "u1", handle: "kev", display_name: "Kev", avatar_url: null }], error: null });
    const res = await GET(get("/api/search/suggest?q=dra"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      titles: [{ id: "p1", title: "Dragon over Kyoto" }],
      creators: [{ id: "u1", handle: "kev", displayName: "Kev", avatarUrl: null }],
    });
    expect(calls).toEqual([
      { fn: "suggest_titles", args: { q: "dra", lim: 8, show_adult: false } },
      { fn: "search_creators", args: { q: "dra", lim: 4, show_adult: false } },
    ]);
  });

  it("answers an empty q with empty lists and no query, and a missing migration with 503", async () => {
    const { GET } = await import("../../app/api/search/suggest/route");
    const calls = fakeSupabase(() => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.suggest_titles(lim, q) in the schema cache" } }));
    expect(await (await GET(get("/api/search/suggest?q="))).json()).toEqual({ titles: [], creators: [] });
    expect(calls).toEqual([]);
    const res = await GET(get("/api/search/suggest?q=dra"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(SEARCH_NOT_MIGRATED_MESSAGE);
  });
});

describe("both routes sit behind the feed's gate and rate limit", () => {
  it("proxy.ts lists neither /api/search nor /api/marketplace as public", () => {
    const proxy = readSource(join(ROOT, "proxy.ts"));
    expect(proxy).not.toMatch(/api\/search/);
    expect(proxy).not.toMatch(/api\/marketplace/);
  });

  it.each([
    ["app/api/search/route.ts", "search"],
    ["app/api/search/suggest/route.ts", "search-suggest"],
  ])("%s rate limits with the shared helper before any database access", (path, action) => {
    const src = readSource(join(ROOT, ...path.split("/")));
    const limitedAt = src.search(new RegExp(`checkRequestRateLimit\\(rateLimitKey\\(req, "${action}"\\)`));
    const dbAt = src.search(/getSupabaseServerClient\(\)/);
    expect(limitedAt).toBeGreaterThan(-1);
    expect(dbAt).toBeGreaterThan(-1);
    expect(limitedAt).toBeLessThan(dbAt);
    expect(src).toMatch(/if \(!rate\.allowed\) return rateLimitResponse\(rate\.retryAfterSeconds\);/);
  });
});
