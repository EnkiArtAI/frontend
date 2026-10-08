import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Banned and deleted accounts leave the public reads (2026-10-08), here by
 * behaviour with the real hiddenOwners: a gallery asked for by an upper-case
 * id, the /showcase list (which must keep paging past a hidden card), and a
 * prompt's comments and ratings.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
vi.mock("@/lib/adult-content", async (original) => ({
  ...(await original<typeof import("@/lib/adult-content")>()),
  viewer: async () => ({ userId: null, showAdult: false }),
}));

import { GET as gallery } from "../../app/api/generations/route";
import { GET as showcase } from "../../app/api/prompts/route";
import { GET as comments } from "../../app/api/prompts/[id]/comments/route";

const KEPT = "aaaaaaaa-0000-4000-8000-00000000000a";
const BANNED = "aaaaaaaa-0000-4000-8000-00000000000b";
const P1 = "bbbbbbbb-0000-4000-8000-000000000001";
const P2 = "bbbbbbbb-0000-4000-8000-000000000002";

beforeEach(() => {
  db.current = fakePostgrest();
  db.current.tables.users = [
    { id: KEPT, handle: "kept", deleted_at: null, account_status: "active" },
    { id: BANNED, handle: "barred", deleted_at: null, account_status: "active" },
  ];
  db.current.tables.bans = [];
});
const ban = () => db.current!.tables.bans.push({ user_id: BANNED, lifted_at: null, expires_at: null });

describe("a gallery asked for by an upper-case id", () => {
  const read = async (id: string) => {
    const body = await (await gallery(new Request(`http://enki.test/api/generations?userId=${id}`))).json();
    return ((body.data?.generations ?? body.generations) as { id: string }[]).map((g) => g.id);
  };
  beforeEach(() => {
    db.current!.tables.generated_images = [
      { id: "g1", user_id: BANNED, is_adult: false, is_uploaded: false, visibility: "public", deleted_at: null },
    ];
  });

  it("is the same gallery as the lower-case one", async () => {
    expect(await read(BANNED.toUpperCase())).toEqual(["g1"]);
  });

  it("by a wallet address is no empty gallery while the database is down: 503, and 500 for any other failure", async () => {
    const status = async () => (await gallery(new Request("http://enki.test/api/generations?userId=WaLLet111"))).status;
    db.current!.state.failNext = { table: "user_wallets", op: "select", code: "ECONNREFUSED" };
    expect(await status()).toBe(503);
    db.current!.state.failNext = { table: "user_wallets", op: "select", code: "PGRST000" };
    expect(await status()).toBe(500);
    db.current!.tables.user_wallets = [{ address: "wallet111", user_id: BANNED, removed_at: null }];
    expect(await status()).toBe(200);
  });

  it("is empty once the account is banned, however the id is spelled", async () => {
    ban();
    expect(await read(BANNED.toUpperCase())).toEqual([]);
    expect(await read(BANNED)).toEqual([]);
  });
});

describe("the /showcase list", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "http://db.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
    db.current!.tables.prompts = [
      { id: P1, title: "Kept", creator_id: KEPT, is_listed: true, is_adult: false, prompt_type: "paid", showcase_images: [] },
      { id: P2, title: "Barred", creator_id: BANNED, is_listed: true, is_adult: false, prompt_type: "paid", showcase_images: [] },
    ];
  });
  const list = async () => (await showcase(new NextRequest("http://enki.test/api/prompts?limit=2"))).json();

  it("leaves a banned creator's prompt out and still pages on: a full page read means there may be more", async () => {
    ban();
    const { items, nextCursor } = await list();
    expect(items.map((i: { id: string }) => i.id)).toEqual([P1]);
    expect(nextCursor).toBe("2");
  });

  it("counts no rating of a banned account on a card", async () => {
    db.current!.tables.prompt_comments = [
      { id: "c1", prompt_id: P1, user_id: KEPT, rating: 5 },
      { id: "c2", prompt_id: P1, user_id: BANNED, rating: 1 },
    ];
    expect((await list()).items[0].rating).toBe(3);
    ban();
    expect((await list()).items[0].rating).toBe(5);
  });

  it("shows nothing it cannot vouch for when the creators cannot be read", async () => {
    db.current!.state.failNext = { table: "bans", op: "select", code: "PGRST000" };
    expect((await list()).items).toEqual([]);
  });
});

describe("a prompt's comments and ratings", () => {
  beforeEach(() => {
    db.current!.tables.prompt_comments = [
      { id: "c1", prompt_id: P1, user_id: KEPT, rating: 4, body: "lovely" },
      { id: "c2", prompt_id: P1, user_id: BANNED, rating: 1, body: "abuse" },
    ];
  });
  const read = async () => (await comments(new NextRequest(`http://enki.test/api/prompts/${P1}/comments`), { params: Promise.resolve({ id: P1 }) })).json();

  it("leave out a banned account's comment and its rating", async () => {
    ban();
    expect(await read()).toEqual({
      comments: [{ id: "c1", handle: "kept", rating: 4, body: "lovely", createdAt: undefined }],
      stats: { count: 1, avgRating: 4 },
    });
  });

  it("answer an outage with 503, never 'no comments yet', whichever read meets it", async () => {
    db.current!.state.failNext = { table: "prompt_comments", op: "select", code: "ECONNREFUSED" };
    expect((await comments(new NextRequest(`http://enki.test/api/prompts/${P1}/comments`), { params: Promise.resolve({ id: P1 }) })).status).toBe(503);
    db.current!.state.failNext = { table: "bans", op: "select", code: "ECONNREFUSED" };
    expect((await comments(new NextRequest(`http://enki.test/api/prompts/${P1}/comments`), { params: Promise.resolve({ id: P1 }) })).status).toBe(503);
  });

  it("show none when the accounts cannot be read", async () => {
    db.current!.state.failNext = { table: "users", op: "select", code: "PGRST000" };
    expect(await read()).toEqual({ comments: [], stats: { count: 0, avgRating: null } });
  });
});
