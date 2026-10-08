import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * The "$100 for feedback" program (Kev, 2026-10-08): staff open a report's
 * attachments by short-lived links and decide it done or rejected; an admin
 * records the payout's transaction; the sender sees all of it on their own
 * reports, and nobody else's.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null, signed: [] as { bucket: string; paths: string[]; ttl: number }[] }));
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    ...(db.current!.client as object),
    storage: { from: (bucket: string) => ({
      createSignedUrls: async (paths: string[], ttl: number) => {
        db.signed.push({ bucket, paths, ttl });
        return { data: paths.map((path) => ({ path, signedUrl: `https://signed.test/${path}`, error: null })), error: null };
      },
    }) },
  }),
}));
vi.mock("@/lib/session-user", async (original) => ({
  ...(await original<typeof import("@/lib/session-user")>()),
  resolveSessionUserId: async (_s: unknown, t: string | null) => ({ "admin-tok": "admin-1", "mod-tok": "mod-1", "anna-tok": "u1" } as Record<string, string>)[t ?? ""] ?? null,
}));
vi.mock("@/lib/crypto", async (original) => ({ ...(await original<typeof import("@/lib/crypto")>()), decryptString: () => "anna@enki.test" }));

import { GET as adminGet } from "../../app/api/admin/route";

const FB1 = "aaaaaaaa-0000-4000-8000-000000000001";
const FB2 = "aaaaaaaa-0000-4000-8000-000000000002";
const get = async (token: string, query = "") => {
  const res = await adminGet(new NextRequest(`http://enki.test/api/admin${query}`, { headers: { "X-Session-Token": token } }));
  return { status: res.status, body: await res.json() };
};
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, user_id: "u1", submitter_name: "anna", description: "The save button does nothing at all.", status: "pending",
  payout_cents: 10000, payout_tx_hash: null, payout_chain_key: null, paid_at: null, reviewer_id: null, reviewed_at: null,
  created_at: "2026-10-08T10:00:00Z", ...extra,
});

const fb1 = () => db.current!.tables.feedback_submissions[0];

beforeEach(() => {
  db.current = fakePostgrest();
  db.signed = [];
  db.current.tables.users = [{ id: "admin-1", role: "admin" }, { id: "mod-1", role: "mod" }, { id: "u1", role: "user", handle: "anna" }, { id: "u2", role: "user", handle: "ben" }];
  db.current.tables.feedback_submissions = [row(FB1), row(FB2, { user_id: "u2", submitter_name: "ben" })];
});

describe("a feedback report's attachments", () => {
  beforeEach(() => {
    db.current!.tables.feedback_attachments = [
      { feedback_id: FB1, storage_key: `${FB1}/0-1.png`, mime_type: "image/png", sort_order: 0 },
      { feedback_id: FB1, storage_key: `${FB1}/1-1.mp4`, mime_type: "video/mp4", sort_order: 1 },
      { feedback_id: FB2, storage_key: `${FB2}/0-1.png`, mime_type: "image/png", sort_order: 0 },
    ];
  });

  it("are signed for that report alone, from the private bucket, for ten minutes", async () => {
    expect(await get("admin-tok", `?feedback=${FB1}`)).toEqual({ status: 200, body: { files: [
      { url: `https://signed.test/${FB1}/0-1.png`, mime: "image/png" },
      { url: `https://signed.test/${FB1}/1-1.mp4`, mime: "video/mp4" },
    ] } });
    expect(db.signed).toEqual([{ bucket: "feedback", paths: [`${FB1}/0-1.png`, `${FB1}/1-1.mp4`], ttl: 600 }]);
  });

  it("open for a mod too", async () => {
    expect((await get("mod-tok", `?feedback=${FB1}`)).status).toBe(200);
  });

  it("are signed for nobody else", async () => {
    expect((await get("anna-tok", `?feedback=${FB1}`)).status).toBe(403);
    expect((await get("", `?feedback=${FB1}`)).status).toBe(401);
    expect(db.signed).toEqual([]);
  });

  it("sign nothing for an id that is no report id, nor for a report without any", async () => {
    expect((await get("admin-tok", "?feedback=1;drop")).status).toBe(400);
    db.current!.tables.feedback_attachments = [];
    expect((await get("admin-tok", `?feedback=${FB1}`)).body).toEqual({ files: [] });
    expect(db.signed).toEqual([]);
  });
});

describe("a feedback sender's email", () => {
  it("is shown to admins alone", async () => {
    Object.assign(fb1(), { submitter_email_ct: "ct", submitter_email_iv: "iv", submitter_email_tag: "tag", submitter_email_kid: "k" });
    expect((await get("admin-tok")).body.feedback[0].email).toBe("anna@enki.test");
    expect((await get("mod-tok")).body.feedback[0].email).toBeNull();
  });
});
