import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Report (Kev, 2026-10-08): a simple popup with a reason to pick and a box to
 * say what is wrong; the report shows up in the admin panel. Only a signed-in
 * user reports, only something that exists, and the reason sets how urgent it
 * is, not the reporter.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
const session = vi.hoisted(() => ({ userId: null as string | null, down: false }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: async () => {
    if (session.down) throw new (await import("@/lib/db-error")).DbUnreachableError();
    return session.userId;
  },
}));

import { POST } from "../../app/api/reports/route";

const PROMPT = "aaaaaaaa-0000-4000-8000-000000000001";
const IMAGE = "aaaaaaaa-0000-4000-8000-000000000002";
const CREATOR = "aaaaaaaa-0000-4000-8000-000000000003";
const MISSING = "aaaaaaaa-0000-4000-8000-0000000000ff";
let reporter = 0;

const send = async (body: unknown) => {
  const res = await POST(new NextRequest("http://enki.test/api/reports", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  db.current = fakePostgrest();
  db.current.tables.prompts = [{ id: PROMPT }];
  db.current.tables.generated_images = [{ id: IMAGE }];
  db.current.tables.users = [{ id: CREATOR }];
  db.current.tables.reports = [];
  // A fresh reporter per test: the hourly limit is per user.
  Object.assign(session, { userId: `reporter-${++reporter}`, down: false });
});

describe("a report", () => {
  it.each([
    ["prompt", PROMPT, "copyright", "medium"],
    ["generation", IMAGE, "child_safety", "critical"],
    ["user", CREATOR, "impersonation", "medium"],
  ])("of a %s lands pending for the admin, with the severity its reason carries", async (targetType, targetId, reason, severity) => {
    expect((await send({ targetType, targetId, reason, details: "  my own artwork  " })).status).toBe(201);
    expect(db.current!.tables.reports).toEqual([expect.objectContaining({
      reporter_user_id: session.userId, target_type: targetType, target_uuid: targetId, reason, severity,
      details: "my own artwork", status: "pending",
    })]);
  });

  it("needs no words except for 'something else'", async () => {
    expect((await send({ targetType: "prompt", targetId: PROMPT, reason: "spam" })).status).toBe(201);
    expect(db.current!.tables.reports[0].details).toBeNull();
    expect(await send({ targetType: "user", targetId: CREATOR, reason: "other", details: "   " }))
      .toEqual({ status: 400, body: { error: "Tell us what is wrong" } });
  });

  it("is sent once: the same person reporting the same thing again while it is open adds nothing", async () => {
    await send({ targetType: "prompt", targetId: PROMPT, reason: "spam" });
    expect(await send({ targetType: "prompt", targetId: PROMPT, reason: "hate" })).toEqual({ status: 200, body: { ok: true } });
    expect(db.current!.tables.reports).toHaveLength(1);
  });

  it("from someone else, or once the first is decided, is a new report", async () => {
    await send({ targetType: "prompt", targetId: PROMPT, reason: "spam" });
    db.current!.tables.reports[0].status = "dismissed";
    expect((await send({ targetType: "prompt", targetId: PROMPT, reason: "spam" })).status).toBe(201);
    session.userId = "someone-else";
    expect((await send({ targetType: "prompt", targetId: PROMPT, reason: "spam" })).status).toBe(201);
    expect(db.current!.tables.reports).toHaveLength(3);
  });
});

describe("no report is written", () => {
  it("without a session (a banned one resolves to nobody)", async () => {
    session.userId = null;
    expect(await send({ targetType: "prompt", targetId: PROMPT, reason: "spam" })).toEqual({ status: 401, body: { error: "Sign in to report" } });
    expect(db.current!.tables.reports).toEqual([]);
  });

  it.each([
    ["an unknown reason", { targetType: "prompt", targetId: PROMPT, reason: "nsfw" }],
    ["an unknown target", { targetType: "comment", targetId: PROMPT, reason: "spam" }],
    ["an id that is no uuid", { targetType: "prompt", targetId: "p1", reason: "spam" }],
    ["words past 1000 characters", { targetType: "prompt", targetId: PROMPT, reason: "spam", details: "x".repeat(1001) }],
  ])("for %s", async (_name, body) => {
    expect((await send(body)).status).toBe(400);
    expect(db.current!.tables.reports).toEqual([]);
  });

  it("for something that does not exist, looked up where its kind lives", async () => {
    expect((await send({ targetType: "generation", targetId: MISSING, reason: "spam" })).status).toBe(404);
    // A prompt's id is no image and no profile.
    expect((await send({ targetType: "generation", targetId: PROMPT, reason: "spam" })).status).toBe(404);
    expect((await send({ targetType: "user", targetId: PROMPT, reason: "spam" })).status).toBe(404);
    expect(db.current!.tables.reports).toEqual([]);
  });

  it("past ten in an hour from one person", async () => {
    for (let i = 0; i < 10; i++) await send({ targetType: "prompt", targetId: PROMPT, reason: "spam" });
    expect((await send({ targetType: "prompt", targetId: PROMPT, reason: "spam" })).status).toBe(429);
  });

  it("when the database is down: 503, not 'sign in'", async () => {
    session.down = true;
    const r = await send({ targetType: "prompt", targetId: PROMPT, reason: "spam" });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("DB_UNAVAILABLE");
  });

  it("when a read fails: 500, nothing half-written", async () => {
    db.current!.state.failNext = { table: "reports", op: "select", code: "PGRST000" };
    expect((await send({ targetType: "prompt", targetId: PROMPT, reason: "spam" })).status).toBe(500);
    expect(db.current!.tables.reports).toEqual([]);
  });
});
