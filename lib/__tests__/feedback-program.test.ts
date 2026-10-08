import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import bs58 from "bs58";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { fakePostgrest } from "./_fake-postgrest";
import { FEEDBACK_STATUS } from "@/lib/feedback";

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

import { GET as adminGet, POST as adminPost } from "../../app/api/admin/route";
import { GET as myFeedback } from "../../app/api/feedback/route";

const FB1 = "aaaaaaaa-0000-4000-8000-000000000001";
const FB2 = "aaaaaaaa-0000-4000-8000-000000000002";
const get = async (token: string, query = "") => {
  const res = await adminGet(new NextRequest(`http://enki.test/api/admin${query}`, { headers: { "X-Session-Token": token } }));
  return { status: res.status, body: await res.json() };
};
const post = async (token: string, body: unknown) => {
  const res = await adminPost(new NextRequest("http://enki.test/api/admin", { method: "POST", headers: { "X-Session-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const ADMIN_ROUTE = readSource(join(__dirname, "..", "..", "app", "api", "admin", "route.ts"));
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

describe("deciding a feedback report", () => {
  const decide = (token: string, status: string, id = FB1) => post(token, { resource: "feedback", action: "setStatus", id, status });

  it("writes only values the live column's CHECK takes (probed 2026-10-08)", () => {
    const allowed = ["pending", "reviewed", "accepted", "rejected", "paid", "duplicate", "spam"];
    expect(Object.values(FEEDBACK_STATUS).every((v) => allowed.includes(v))).toBe(true);
    expect(FEEDBACK_STATUS).toEqual({ open: "pending", done: "accepted", rejected: "rejected" });
  });

  it("an admin marks it done, and who and when are kept", async () => {
    expect(await decide("admin-tok", "done")).toEqual({ status: 200, body: { ok: true } });
    expect(fb1()).toMatchObject({ status: FEEDBACK_STATUS.done, reviewer_id: "admin-1" });
    expect(fb1().reviewed_at).toEqual(expect.any(String));
  });

  it("a mod rejects and reopens, but never marks it done: done promises the $100", async () => {
    expect((await decide("mod-tok", "done")).status).toBe(403);
    expect(fb1()).toMatchObject({ status: "pending", reviewer_id: null });
    expect((await decide("mod-tok", "rejected")).status).toBe(200);
    expect(fb1()).toMatchObject({ status: FEEDBACK_STATUS.rejected, reviewer_id: "mod-1" });
    expect((await decide("mod-tok", "open")).status).toBe(200);
    expect(fb1().status).toBe("pending");
  });

  it("a mod cannot take back an admin's done: the $100 promise stands until an admin changes it", async () => {
    await decide("admin-tok", "done");
    for (const status of ["rejected", "open"]) expect((await decide("mod-tok", status)).status).toBe(403);
    expect(fb1()).toMatchObject({ status: FEEDBACK_STATUS.done, reviewer_id: "admin-1" });
    expect((await decide("admin-tok", "open")).status).toBe(200);
    expect(fb1().status).toBe("pending");
    // The fake answers every column; the live read, deciding and paying alike, names status.
    expect(ADMIN_ROUTE.split('.from("feedback_submissions").select("status, paid_at").eq("id", body.id).maybeSingle();').length - 1).toBe(2);
  });

  it("takes only the three decisions", async () => {
    for (const status of ["paid", "pending", "accepted", "constructor", ""]) expect((await decide("admin-tok", status)).status).toBe(400);
    expect(fb1()).toMatchObject({ status: "pending", reviewer_id: null });
  });

  it("leaves a paid report as it is", async () => {
    Object.assign(fb1(), { status: FEEDBACK_STATUS.done, paid_at: "2026-10-08T12:00:00Z" });
    expect((await decide("admin-tok", "rejected")).status).toBe(409);
    expect(fb1().status).toBe(FEEDBACK_STATUS.done);
  });

  it("says so for a report that does not exist", async () => {
    expect((await decide("admin-tok", "done", "aaaaaaaa-0000-4000-8000-0000000000ff")).status).toBe(404);
  });

  it("the tab shows each report's decision, read with the report", async () => {
    fb1().status = FEEDBACK_STATUS.rejected;
    expect((await get("admin-tok")).body.feedback.map((f: { state: string }) => f.state)).toEqual(["rejected", "open"]);
    // The fake answers every column; the live read only those it names.
    expect(ADMIN_ROUTE).toMatch(/const FEEDBACK_COLUMNS = "[^"]*\bstatus\b[^"]*";/);
  });
});

describe("recording a payout", () => {
  const SIG = bs58.encode(new Uint8Array(64).fill(7));
  const pay = (token: string, signature: unknown, id = FB1) => post(token, { resource: "feedback", action: "markPaid", id, signature });

  it("an admin records the transaction, and the report is done and paid", async () => {
    expect(await pay("admin-tok", ` ${SIG} `)).toEqual({ status: 200, body: { ok: true } });
    expect(fb1()).toMatchObject({ payout_tx_hash: SIG, payout_chain_key: "solana", status: FEEDBACK_STATUS.done, reviewer_id: "admin-1" });
    expect(fb1().paid_at).toEqual(expect.any(String));
    expect(fb1().reviewed_at).toEqual(expect.any(String));
  });

  it("is not a mod's to record", async () => {
    expect((await pay("mod-tok", SIG)).status).toBe(403);
    expect(fb1().paid_at).toBeNull();
  });

  it("takes a transaction signature and nothing else", async () => {
    const address = bs58.encode(new Uint8Array(32).fill(7));
    for (const bad of [undefined, "", "abc", address, SIG.slice(0, -1) + "0", SIG + SIG.slice(0, 2), `https://solscan.io/tx/${SIG}`]) {
      expect((await pay("admin-tok", bad)).status).toBe(400);
    }
    expect(fb1().paid_at).toBeNull();
  });

  it("pays each report once, and one transfer pays one report", async () => {
    await pay("admin-tok", SIG);
    expect((await pay("admin-tok", bs58.encode(new Uint8Array(64).fill(8)))).status).toBe(409);
    expect(fb1().payout_tx_hash).toBe(SIG);
    expect((await pay("admin-tok", SIG, FB2)).status).toBe(409);
    expect(db.current!.tables.feedback_submissions[1].paid_at).toBeNull();
  });

  it("a second Confirm for the same report never reads as another report's transfer", async () => {
    // The first record committed between the second request's reads: its own row now carries the signature.
    Object.assign(fb1(), { payout_tx_hash: SIG });
    expect(await pay("admin-tok", SIG)).toEqual({ status: 200, body: { ok: true } });
    expect(fb1().paid_at).toEqual(expect.any(String));
  });

  it("a rejected report is reopened before it is paid", async () => {
    fb1().status = FEEDBACK_STATUS.rejected;
    expect((await pay("admin-tok", SIG)).status).toBe(409);
    expect(fb1().paid_at).toBeNull();
  });

  it("says so for a report that does not exist", async () => {
    expect((await pay("admin-tok", SIG, "aaaaaaaa-0000-4000-8000-0000000000ff")).status).toBe(404);
  });

  it("the tab names where the money goes and links the transfer once sent", async () => {
    db.current!.tables.user_wallets = [
      { user_id: "u1", address: "LiveSol", chain_family: "solana", removed_at: null },
      { user_id: "u1", address: "0xEvm", chain_family: "evm", removed_at: null },
      { user_id: "u1", address: "OldSol", chain_family: "solana", removed_at: "2026-09-01T00:00:00Z" },
      // A legacy lowercased row decodes to a key nobody holds: never named.
      { user_id: "u1", address: "7xkxtg2cw87d97txjsdpbd5jbkheTqa83tzrujosgasu".toLowerCase(), chain_family: "solana", removed_at: null },
    ];
    await pay("admin-tok", SIG);
    const { feedback } = (await get("admin-tok")).body;
    expect(feedback[0]).toMatchObject({ wallet: "LiveSol", paid: true, txUrl: `https://explorer.solana.com/tx/${SIG}` });
    expect(feedback[1]).toMatchObject({ wallet: null, paid: false, txUrl: null });
    // The fake answers every column; the live reads only those they name.
    expect(ADMIN_ROUTE).toMatch(/const FEEDBACK_COLUMNS = "[^"]*\bpayout_tx_hash, payout_chain_key\b[^"]*";/);
    expect(ADMIN_ROUTE).toContain('supabase.from("user_wallets").select("user_id, address").in("user_id", chunk).eq("chain_family", "solana").is("removed_at", null)');
  });
});

describe("the sender's own reports", () => {
  const mine = async (token: string) => {
    const res = await myFeedback(new NextRequest("http://enki.test/api/feedback", { headers: { "X-Session-Token": token } }));
    return { status: res.status, body: await res.json() };
  };
  const FB3 = "aaaaaaaa-0000-4000-8000-000000000003";

  it("lists theirs alone, with the decision and the payment, never the reviewer", async () => {
    const SIG = bs58.encode(new Uint8Array(64).fill(7));
    db.current!.tables.feedback_submissions.push(row(FB3, { description: "A".repeat(200), status: FEEDBACK_STATUS.done, paid_at: "2026-10-08T12:00:00Z", payout_tx_hash: SIG, payout_chain_key: "solana", reviewer_id: "admin-1", reviewer_notes: "internal" }));
    expect(await mine("anna-tok")).toEqual({ status: 200, body: { items: [
      { id: FB1, at: "2026-10-08T10:00:00Z", preview: "The save button does nothing at all.", state: "open", paid: false, payoutCents: 10000, txUrl: null },
      { id: FB3, at: "2026-10-08T10:00:00Z", preview: "A".repeat(80), state: "done", paid: true, payoutCents: 10000, txUrl: `https://explorer.solana.com/tx/${SIG}` },
    ] } });
    // The fake answers every column; the live read only those it names.
    const route = readSource(join(__dirname, "..", "..", "app", "api", "feedback", "route.ts"));
    expect(route).toContain('.select("id, description, status, paid_at, payout_cents, payout_tx_hash, payout_chain_key, created_at")');
  });

  it("asks for a session", async () => {
    expect((await mine("")).status).toBe(401);
  });
});

describe("the Feedback tab's list", () => {
  it("keeps every report staff still owe a decision or the $100, however many newer ones arrive", async () => {
    const FB3 = "aaaaaaaa-0000-4000-8000-000000000003";
    const FB4 = "aaaaaaaa-0000-4000-8000-000000000004";
    // Rows come back in insertion order: the hundred newer ones first.
    const newer = Array.from({ length: 100 }, (_, i) => row(`bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`, { status: FEEDBACK_STATUS.rejected, created_at: "2026-10-09T10:00:00Z" }));
    db.current!.tables.feedback_submissions = [...newer, row(FB1, { status: FEEDBACK_STATUS.done }), row(FB2, { status: FEEDBACK_STATUS.rejected }), row(FB3),
      row(FB4, { status: FEEDBACK_STATUS.done, paid_at: "2026-10-08T12:00:00Z" })];
    const ids = (await get("admin-tok")).body.feedback.map((f: { id: string }) => f.id);
    expect(ids).toContain(FB1); // done, unpaid: the $100 is owed
    expect(ids).toContain(FB3); // still open
    expect(ids).not.toContain(FB2); // rejected, and older than the newest hundred
    expect(ids).not.toContain(FB4); // paid, and older than the newest hundred
    expect(ids).toHaveLength(102);
    // Newest first, each once.
    expect(ids.slice(0, 100)).toEqual(newer.map((r) => r.id));
  });
});
