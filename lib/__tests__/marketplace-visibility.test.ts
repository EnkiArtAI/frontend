import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { fakePostgrest } from "./_fake-postgrest";

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: unknown; count?: number };
const db = vi.hoisted(() => ({ current: null as ReturnType<typeof fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({
  from: (table: string) => {
    const q = (db.current!.client as SupabaseClient).from(table) as unknown as {
      range: (from: number, to: number) => unknown;
      then: (resolve: (r: Result) => unknown) => unknown;
    };
    if (table !== "prompts") return q;
    // This suite needs real offset/limit behaviour in addition to the shared fake's filters.
    let from = 0, to = Infinity;
    const original = q.then.bind(q);
    q.range = (a, b) => { from = a; to = b; return q; };
    q.then = (resolve) => original((r) => resolve({ ...r, data: r.data?.slice(from, to + 1) ?? null }));
    return q;
  },
}) }));
vi.mock("@/lib/adult-content", async (original) => ({
  ...(await original<typeof import("@/lib/adult-content")>()),
  viewer: async () => ({ userId: null, showAdult: false }),
}));
import { GET } from "../../app/api/marketplace/prompts/route";

const creator = "aaaaaaaa-0000-4000-8000-000000000001";
const row = (id: string, patch: Row = {}) => ({
  id, creator_id: creator, title: id, prompt_type: "free", is_listed: true,
  listing_status: "active", deleted_at: null, is_adult: false, showcase_images: [], ...patch,
});
beforeEach(() => {
  db.current = fakePostgrest();
  db.current.tables.users = [{ id: creator, handle: "creator", account_status: "active", deleted_at: null }];
  db.current.tables.bans = [];
  db.current.tables.prompts = [
    row("draft", { listing_status: "draft" }),
    row("deleted", { deleted_at: "2026-10-01T00:00:00Z" }),
    row("delisted", { listing_status: "delisted" }),
    row("unlisted", { is_listed: false }),
    row("a"), row("b"), row("c"),
  ];
});
const read = async (cursor = "0") => {
  const res = await GET(new NextRequest("http://enki.test/api/marketplace/prompts?limit=2&cursor=" + cursor));
  expect(res.status).toBe(200);
  return res.json();
};

describe("marketplace listing visibility before pagination", () => {
  it("the first page contains two active, undeleted listings despite newer hidden rows", async () => {
    const body = await read();
    expect(body.prompts.map((p: { id: string }) => p.id)).toEqual(["a", "b"]);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe("2");
  });

  it("the next cursor skips visible rows, not draft or deleted rows", async () => {
    const body = await read("2");
    expect(body.prompts.map((p: { id: string }) => p.id)).toEqual(["c"]);
    expect(body.hasMore).toBe(false);
  });

  it("an entirely unavailable shelf has no cards and no next page", async () => {
    db.current!.tables.prompts = db.current!.tables.prompts.slice(0, 4);
    expect(await read()).toMatchObject({ prompts: [], hasMore: false });
  });
});
