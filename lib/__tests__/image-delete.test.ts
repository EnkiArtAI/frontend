import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * DELETE /api/images/[id] (ENG-02): the gallery's delete. It removes one
 * generated_images row of the session's own account, behind the passkey
 * step-up once one is enrolled, and nothing else. The real step-up check
 * runs; only the database is in memory.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;

const query = (table: string) => {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  const q = {
    select: () => q,
    update: (values: Row) => { patch = values; return q; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    is: (c: string, v: null) => { filters.push((r) => (r[c] ?? null) === v); return q; },
    // The step-up also reads code factors with not(); none here, like no passkey.
    not: (c: string, _op: string, v: null) => { filters.push((r) => (r[c] ?? null) !== v); return q; },
    then: (ok: (v: unknown) => unknown) => {
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (patch) rows.forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ data: rows, error: null, count: rows.length }).then(ok);
    },
  };
  return q;
};
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from: query }) }));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: async (_s: unknown, t: string | null) => ({ "owner-tok": OWNER, "other-tok": OTHER } as Record<string, string>)[t ?? ""] ?? null,
}));

process.env.AUTH_PEPPER = Buffer.alloc(32, 7).toString("base64");
const OWNER = "0b5f2c1e-1111-4222-8333-444455556666";
const OTHER = "9c1d2e3f-1111-4222-8333-444455556666";
const IMG = "1a2b3c4d-1111-4222-8333-444455556666";
const IMG2 = "5e6f7a8b-1111-4222-8333-444455556666";

import { DELETE } from "../../app/api/images/[id]/route";
import { mintStepUpToken } from "../webauthn";
import type { NextRequest } from "next/server";

const del = (id: string, headers: Record<string, string> = {}) =>
  DELETE(new Request(`http://enki.test/api/images/${id}`, { method: "DELETE", headers }) as unknown as NextRequest, { params: Promise.resolve({ id }) });
const deleted = (id: string) => tables.generated_images.find((r) => r.id === id)?.deleted_at != null;

beforeEach(() => {
  tables = {
    webauthn_credentials: [],
    generated_images: [
      { id: IMG, user_id: OWNER, deleted_at: null },
      { id: IMG2, user_id: OWNER, deleted_at: null },
    ],
  };
});

describe("deleting a gallery image", () => {
  it("deletes the owner's image and leaves the others", async () => {
    const res = await del(IMG, { "X-Session-Token": "owner-tok" });
    expect(res.status).toBe(200);
    expect(deleted(IMG)).toBe(true);
    expect(deleted(IMG2)).toBe(false);
  });

  it("deletes once: a second delete finds nothing", async () => {
    expect((await del(IMG, { "X-Session-Token": "owner-tok" })).status).toBe(200);
    expect((await del(IMG, { "X-Session-Token": "owner-tok" })).status).toBe(404);
  });

  it("refuses without a session", async () => {
    expect((await del(IMG)).status).toBe(401);
    expect(deleted(IMG)).toBe(false);
  });

  it("answers someone else's image like a missing one and keeps it", async () => {
    expect((await del(IMG, { "X-Session-Token": "other-tok" })).status).toBe(404);
    expect(deleted(IMG)).toBe(false);
  });

  it("asks for the passkey once one is enrolled, and accepts only this image's token", async () => {
    tables.webauthn_credentials.push({ id: "cred", user_id: OWNER });
    const bare = await del(IMG, { "X-Session-Token": "owner-tok" });
    expect(bare.status).toBe(401);
    expect((await bare.json()).stepUp).toBe(true);
    const otherScope = await mintStepUpToken(OWNER, `delete-work:${IMG2}`);
    expect((await del(IMG, { "X-Session-Token": "owner-tok", "X-StepUp-Token": otherScope })).status).toBe(401);
    expect(deleted(IMG)).toBe(false);

    const token = await mintStepUpToken(OWNER, `delete-work:${IMG}`);
    expect((await del(IMG, { "X-Session-Token": "owner-tok", "X-StepUp-Token": token })).status).toBe(200);
    expect(deleted(IMG)).toBe(true);
  });
});
