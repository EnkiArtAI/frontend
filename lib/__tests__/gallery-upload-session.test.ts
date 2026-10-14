import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import type { NextRequest } from "next/server";

/**
 * MFA-2 + REC-9. The upload route took its owner from a form field and
 * "checked" it against a header holding the same value, so anyone could file
 * images under anyone; with no blob token it stored the image as a data URL
 * inside the row; and a failed insert left the uploaded files orphaned.
 */

const session = vi.fn<(token: string | null) => Promise<string | null>>();
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: (_s: unknown, t: string | null) => session(t) }));

const inserted: Record<string, unknown>[] = [];
let insertError: { message: string; code?: string } | null = null;
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from: () => ({
      insert: (rows: Record<string, unknown>[]) => {
        inserted.push(...rows);
        return { select: () => ({ single: async () => (insertError ? { data: null, error: insertError } : { data: { id: "img-1" }, error: null }) }) };
      },
    }),
  }),
}));

const put = vi.fn(async (name: string) => ({ url: `https://s.public.blob.vercel-storage.com/${name}` }));
const del = vi.fn(async (_urls: string[]) => {});
vi.mock("@vercel/blob", () => ({ put: (n: string) => put(n), del: (u: string[]) => del(u) }));
let derived: unknown = null;
vi.mock("@/lib/imageDerivatives", () => ({ tryMakeDerivatives: async () => derived }));
vi.mock("@/lib/moderation", () => ({ moderate: async () => ({ allowed: true }), CLIENT_BLOCK_MESSAGE: "blocked" }));
vi.mock("@/lib/moderation-enforcement", () => ({ recordModerationEvent: async () => {} }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (p: unknown) => p }));
// The image check's verdict, as each test sets it (its own tests are image-check*.test.ts).
const judged = vi.hoisted(() => ({ verdict: "clear" as string, cases: [] as unknown[] }));
vi.mock("@/lib/moderation/image-check-bytes", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/image-check-bytes")>()),
  checkImageBytes: async () => ({ verdict: judged.verdict, ...(judged.verdict === "child_safety" ? { scores: { minor: 0.9 } } : {}) }),
}));
vi.mock("@/lib/moderation/image-case", () => ({ recordImageCase: async (_s: unknown, c: unknown) => { judged.cases.push(c); } }));

import { POST } from "../../app/api/gallery/upload/route";
import { DbUnreachableError } from "@/lib/db-error";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function upload(headers: Record<string, string>, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return POST(new Request("http://x/api/gallery/upload", { method: "POST", headers, body: form }) as unknown as NextRequest);
}

beforeEach(() => {
  inserted.length = 0;
  insertError = null;
  derived = null;
  put.mockClear();
  del.mockClear();
  session.mockReset();
  judged.verdict = "clear";
  judged.cases.length = 0;
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
  vi.stubEnv("VERCEL_BLOB_API_URL", "http://127.0.0.1:9"); // a stray real SDK call reaches nothing
});
afterEach(() => vi.unstubAllEnvs());

describe("an upload and the image check", () => {
  beforeEach(() => session.mockResolvedValue(USER_A));

  it.each([
    ["refused", "blocked", 422, "This image can't be uploaded to Enki."],
    ["not judged", "unavailable", 503, "Your image could not be checked right now, so it was not uploaded. Please try again."],
  ])("%s: nothing is stored and no row is written", async (_name, verdict, status, error) => {
    judged.verdict = verdict;
    const res = await upload({ "X-Session-Token": "tok-a" });
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error?: string }).error).toBe(error);
    expect(put).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(judged.cases).toEqual([]);
  });

  it("child safety: nothing stored, the same refusal, and a case with the bytes", async () => {
    judged.verdict = "child_safety";
    const res = await upload({ "X-Session-Token": "tok-a" });
    expect(res.status).toBe(422);
    expect(put).not.toHaveBeenCalled();
    expect(judged.cases).toEqual([expect.objectContaining({ surface: "upload", bytes: Buffer.from([137, 80, 78, 71]), scores: { minor: 0.9 } })]);
  });

  it("18+: stored and marked", async () => {
    judged.verdict = "adult";
    expect((await upload({ "X-Session-Token": "tok-a" })).status).toBe(201);
    expect(inserted[0].is_adult).toBe(true);
  });

  it("is limited to 20 a minute per account: every upload costs Enki two paid calls", async () => {
    session.mockResolvedValue(USER_B);
    for (let i = 0; i < 20; i++) expect((await upload({ "X-Session-Token": "tok-b" })).status).toBe(201);
    expect((await upload({ "X-Session-Token": "tok-b" })).status).toBe(429);
  });

  it("clear: stored and not marked", async () => {
    expect((await upload({ "X-Session-Token": "tok-a" })).status).toBe(201);
    expect(inserted[0].is_adult).toBe(false);
  });
});

describe("POST /api/gallery/upload", () => {
  it("files the image under the session's account, whatever the form or headers claim", async () => {
    session.mockImplementation(async (t) => (t === "tok-a" ? USER_A : null));
    const res = await upload({ "X-Session-Token": "tok-a", "X-Wallet-Address": USER_B }, { userId: USER_B });
    expect(res.status).toBe(201);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].user_id).toBe(USER_A);
    expect(put.mock.calls[0][0]).toMatch(new RegExp(`^gallery/${USER_A}/`));
  });

  it("refuses a caller without a session, or a banned one, before anything is stored", async () => {
    session.mockResolvedValue(null);
    const callers: Record<string, string>[] = [{}, { "X-Wallet-Address": USER_B }, { "X-Session-Token": "banned" }];
    for (const headers of callers) {
      const res = await upload(headers, { userId: USER_B });
      expect(res.status).toBe(401);
    }
    expect(put).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("refuses without a store instead of writing a data URL into the row", async () => {
    session.mockResolvedValue(USER_A);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const res = await upload({ "X-Session-Token": "tok-a" });
    expect(res.status).toBe(503);
    expect(inserted).toHaveLength(0);
  });

  it("deletes every uploaded file, renditions included, when the row is refused", async () => {
    session.mockResolvedValue(USER_A);
    const rendition = { buffer: Buffer.from([1]), bytes: 1 };
    derived = { preview: rendition, thumb: rendition, width: 1, height: 1 };
    insertError = { message: "violates check constraint", code: "23514" };
    const res = await upload({ "X-Session-Token": "tok-a" });
    expect(res.status).toBe(500);
    expect(put).toHaveBeenCalledTimes(3);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0][0]).toEqual(put.mock.calls.map(([n]) => `https://s.public.blob.vercel-storage.com/${n}`));
  });

  it("keeps the files when the answer was lost or came from a gateway, since the row may exist", async () => {
    session.mockResolvedValue(USER_A);
    for (const lost of [{ message: "TypeError: fetch failed" }, { message: "upstream request timeout", code: "" }]) {
      insertError = lost;
      const res = await upload({ "X-Session-Token": "tok-a" });
      expect(res.status, lost.message).toBe(503);
    }
    expect(del).not.toHaveBeenCalled();
  });

  it("does not call a dead blob store a dead database", async () => {
    session.mockResolvedValue(USER_A);
    put.mockRejectedValueOnce(new TypeError("fetch failed"));
    const res = await upload({ "X-Session-Token": "tok-a" });
    expect(res.status).toBe(500);
    expect(await res.json()).not.toMatchObject({ code: "DB_UNAVAILABLE" });
  });

  it("answers a dead database with the honest 503, not a 500", async () => {
    session.mockRejectedValue(new DbUnreachableError());
    const res = await upload({ "X-Session-Token": "tok-a" });
    expect(res.status).toBe(503);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("the callers", () => {
  const ROOT = join(__dirname, "..", "..");
  it("the showroom sends the session, not a wallet address", () => {
    const zone = readSource(join(ROOT, "components", "ShowroomUploadZone.tsx"));
    expect(zone).toMatch(/headers: auth,/);
    expect(zone).toMatch(/const auth = sessionAuthHeaders\(\);/);
    expect(zone).not.toMatch(/X-Wallet-Address|append\('userId'/);
  });

  it("the showroom shows the upload button to an email login too", () => {
    const zone = readSource(join(ROOT, "components", "ShowroomUploadZone.tsx"));
    expect(zone).toMatch(/const authenticated = emailAuthed \|\| !!account \|\| solanaConnected;/);
  });
});
