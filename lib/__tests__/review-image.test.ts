import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

/**
 * A review shows one of the reviewer's own images made with the prompt (Kev,
 * 2026-10-13): POST /api/prompts/[id]/comments checks the image id against
 * the session user and the prompt before it writes, and GET hands the row's
 * current preview back as imageUrl.
 */
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ client: null as SupabaseClient | null, images: [] as Row[], inserted: [] as Row[], comments: [] as Row[] }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client! }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => "u-mara" }));
vi.mock("@/lib/notifications", () => ({ notifyEvent: async () => undefined }));
vi.mock("@/lib/hidden-owners", () => ({ hiddenOwners: async () => new Set<string>() }));
import { GET, POST } from "../../app/api/prompts/[id]/comments/route";

const promptId = "bbbbbbbb-0000-4000-8000-000000000001";
const mine = "cccccccc-0000-4000-8000-000000000001";
const theirs = "cccccccc-0000-4000-8000-000000000002";

async function fetchRows(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(req.url);
  const p = url.searchParams;
  const json = (rows: unknown) => new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.pathname.endsWith("/generated_images")) {
    const eq = (k: string) => p.get(k)?.replace(/^eq\./, "");
    const ids = p.get("id")?.startsWith("in.(") ? p.get("id")!.slice(4, -1).split(",") : null;
    return json(db.images.filter((r) =>
      (ids ? ids.includes(String(r.id)) : r.id === eq("id"))
      && (!p.has("user_id") || r.user_id === eq("user_id"))
      && (!p.has("prompt_id") || r.prompt_id === eq("prompt_id"))
      && (!p.has("is_uploaded") || String(r.is_uploaded) === eq("is_uploaded"))
      && (p.get("deleted_at") !== "is.null" || r.deleted_at == null)));
  }
  if (url.pathname.endsWith("/prompt_comments")) {
    if (req.method === "POST") {
      db.inserted.push(JSON.parse(await req.text()) as Row);
      return new Response(null, { status: 201 });
    }
    return json(db.comments);
  }
  if (url.pathname.endsWith("/users")) return json([{ id: "u-mara", handle: "mara" }]);
  // The owner notification's lookups (notifyEvent itself is mocked).
  if (url.pathname.endsWith("/prompts")) return json([{ creator_id: "u-artist", title: "Museum Catalogue Portrait" }]);
  throw new Error("Unexpected local database fixture: " + url.pathname);
}

beforeEach(() => {
  db.images = [
    { id: mine, user_id: "u-mara", prompt_id: promptId, is_uploaded: false, deleted_at: null, preview_url: "https://blob/mine.webp", storage_url: "https://blob/mine.png" },
    { id: theirs, user_id: "u-other", prompt_id: promptId, is_uploaded: false, deleted_at: null, preview_url: null, storage_url: "https://blob/theirs.png" },
  ];
  db.inserted = [];
  db.comments = [];
  db.client = createClient("http://db.test", "ci-dummy", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchRows } });
});

const post = (body: unknown) =>
  POST(new NextRequest("http://enki.test/api/prompts/" + promptId + "/comments", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", "X-Session-Token": "t" } }), { params: Promise.resolve({ id: promptId }) });

describe("a review's image", () => {
  it("is written when it is the reviewer's own render of this prompt, alone or with stars and words", async () => {
    expect((await post({ imageId: mine })).status).toBe(201);
    expect((await post({ imageId: mine, rating: 4, body: "Came out great" })).status).toBe(201);
    expect(db.inserted).toEqual([
      { prompt_id: promptId, user_id: "u-mara", rating: null, body: null, image_id: mine },
      { prompt_id: promptId, user_id: "u-mara", rating: 4, body: "Came out great", image_id: mine },
    ]);
  });

  it("is refused when it is someone else's, uploaded, deleted, of another prompt, or not a uuid; nothing is written", async () => {
    expect((await post({ imageId: theirs })).status).toBe(400);
    db.images[0] = { ...db.images[0], is_uploaded: true };
    expect((await post({ imageId: mine })).status).toBe(400);
    db.images[0] = { ...db.images[0], is_uploaded: false, deleted_at: "2026-10-12T00:00:00Z" };
    expect((await post({ imageId: mine })).status).toBe(400);
    db.images[0] = { ...db.images[0], deleted_at: null, prompt_id: "bbbbbbbb-0000-4000-8000-000000000009" };
    expect((await post({ imageId: mine })).status).toBe(400);
    expect((await post({ imageId: "not-a-uuid" })).status).toBe(400);
    expect(db.inserted).toEqual([]);
  });

  it("a plain comment from anyone signed in needs no image", async () => {
    expect((await post({ body: "Lovely" })).status).toBe(201);
    // No image_id key at all: the column may not exist yet (the migration runs before reviews do).
    expect(db.inserted).toEqual([{ prompt_id: promptId, user_id: "u-mara", rating: null, body: "Lovely" }]);
    expect((await post({})).status).toBe(400);
  });

  it("is read back as the row's current preview, and as nothing once the image is gone", async () => {
    db.comments = [
      { id: "r1", user_id: "u-mara", rating: 5, body: null, image_id: mine, created_at: "2026-10-13T00:00:00Z" },
      { id: "r2", user_id: "u-mara", rating: null, body: "gone", image_id: "cccccccc-0000-4000-8000-000000000003", created_at: "2026-10-12T00:00:00Z" },
      { id: "c1", user_id: "u-mara", rating: null, body: "plain", image_id: null, created_at: "2026-10-11T00:00:00Z" },
    ];
    const res = await GET(new NextRequest("http://enki.test/api/prompts/" + promptId + "/comments"), { params: Promise.resolve({ id: promptId }) });
    expect(res.status).toBe(200);
    expect((await res.json()).comments.map((c: { id: string; imageUrl: string | null }) => [c.id, c.imageUrl])).toEqual([
      ["r1", "https://blob/mine.webp"], ["r2", null], ["c1", null],
    ]);
  });
});
