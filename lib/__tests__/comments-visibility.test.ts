import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ client: null as SupabaseClient | null, comments: [] as Row[], users: [] as Row[], bans: [] as Row[], requests: [] as URL[] }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client! }));
import { GET } from "../../app/api/prompts/[id]/comments/route";

const promptId = "bbbbbbbb-0000-4000-8000-000000000001";
const now = "2026-10-11T00:00:00.000Z";
const earlier = "2026-10-01T00:00:00.000Z";
const later = "2026-11-01T00:00:00.000Z";
const user = (id: string, patch: Row = {}) => ({ id, handle: id, account_status: "active", deleted_at: null, ...patch });
const comment = (id: string, owner: string, createdAt = earlier) => ({ id, user_id: owner, prompt_id: promptId, rating: 5, body: id, created_at: createdAt });

// The real Supabase query builder creates the URL. This read-only fixture applies
// relational visibility before limit, like the HEAD-probed PostgREST query.
async function fetchRows(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  db.requests.push(url);
  const p = url.searchParams;
  const activeBans = (owner: string, nested: boolean) => db.bans.filter((b) => {
    if (b.user_id !== owner) return false;
    if (p.get(nested ? "author.active_bans.lifted_at" : "lifted_at") === "is.null" && b.lifted_at != null) return false;
    if (p.has(nested ? "author.active_bans.or" : "or") && b.expires_at != null && String(b.expires_at) <= now) return false;
    return true;
  });
  let rows: Row[];
  if (url.pathname.endsWith("/prompt_comments")) {
    rows = db.comments.filter((r) => r.prompt_id === promptId);
    if (p.get("select")?.includes("author:users!user_id!inner(")) {
      rows = rows.filter((r) => {
        const u = db.users.find((u) => u.id === r.user_id);
        if (!u) return false;
        if (p.get("author.deleted_at") === "is.null" && u.deleted_at != null) return false;
        if (p.has("author.or") && u.account_status != null && u.account_status !== "active") return false;
        return p.get("author.active_bans") !== "is.null" || activeBans(String(u.id), true).length === 0;
      });
    }
    rows = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (p.has("limit")) rows = rows.slice(0, Number(p.get("limit")));
  } else if (url.pathname.endsWith("/users")) rows = db.users;
  else if (url.pathname.endsWith("/bans")) rows = db.bans.filter((b) => activeBans(String(b.user_id), false).includes(b));
  else throw new Error("Unexpected local database fixture: " + url.pathname);
  return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  db.comments = [];
  db.users = [user("kept"), user("hidden")];
  db.bans = [];
  db.requests = [];
  db.client = createClient("http://db.test", "ci-dummy", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchRows } });
});
afterEach(() => vi.useRealTimers());
const read = async () => {
  const res = await GET(new NextRequest("http://enki.test/api/prompts/" + promptId + "/comments"), { params: Promise.resolve({ id: promptId }) });
  expect(res.status).toBe(200);
  return res.json();
};
const crowded = () => {
  db.comments = [...Array.from({ length: 120 }, (_, i) => comment("hidden-" + i, "hidden", now)), comment("kept-comment", "kept")];
};

describe("visible comments before the 100-row cap", () => {
  it("a hundred newer banned comments cannot hide an older visible one", async () => {
    crowded();
    db.bans = [{ user_id: "hidden", lifted_at: null, expires_at: null }];
    const body = await read();
    expect(body.comments.map((c: { id: string }) => c.id)).toEqual(["kept-comment"]);
    expect(body.stats).toEqual({ count: 1, avgRating: 5 });
  });

  it.each([{ deleted_at: earlier }, { account_status: "suspended" }])("newer comments by an unavailable account cannot consume the page: %j", async (patch) => {
    crowded();
    db.users[1] = user("hidden", patch);
    expect((await read()).comments.map((c: { id: string }) => c.id)).toEqual(["kept-comment"]);
  });

  it("lifted and expired bans are visible, an unexpired ban remains hidden", async () => {
    db.users = [user("expired"), user("lifted"), user("future")];
    db.bans = [
      { user_id: "expired", lifted_at: null, expires_at: earlier },
      { user_id: "lifted", lifted_at: earlier, expires_at: null },
      { user_id: "future", lifted_at: null, expires_at: later },
    ];
    db.comments = db.users.map((u) => comment(String(u.id), String(u.id)));
    expect((await read()).comments.map((c: { id: string }) => c.id)).toEqual(["expired", "lifted"]);
    const query = db.requests.find((r) => r.pathname.endsWith("/prompt_comments"))!.searchParams;
    expect(query.get("author.active_bans.or")).toBe("(expires_at.is.null,expires_at.gt." + now + ")");
  });

  it("the cap applies to the newest 100 visible comments", async () => {
    db.comments = Array.from({ length: 110 }, (_, i) => comment("c" + i, "kept", new Date(Date.UTC(2026, 9, 10, 0, i)).toISOString()));
    const body = await read();
    expect(body.comments).toHaveLength(100);
    expect(body.comments[0].id).toBe("c109");
    expect(body.comments[99].id).toBe("c10");
    expect(body.stats.count).toBe(100);
  });
});
