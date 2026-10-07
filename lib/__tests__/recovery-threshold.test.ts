import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * A recovery needs at most as many approvals as the owner has confirmed
 * guardians (review 2026-10-07). The stored default is 2, so an owner with a
 * single guardian could never recover, and nobody would know until then.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
// Before the import below: lib/password-reset reads the pepper when it loads.
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64"); });

import { POST as approve } from "../../app/api/recovery/approve/route";

const U = "11111111-1111-4111-8111-111111111111";
const R = "33333333-3333-4333-8333-333333333333";
const G = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
const CODE = "1234567";

function owner(guardians: number) {
  db.current = fakePostgrest();
  db.current.tables.recovery_requests = [{ id: R, user_id: U, status: "pending", expires_at: new Date(Date.now() + 3600_000).toISOString() }];
  db.current.tables.recovery_guardians = G.slice(0, guardians).map((id) => ({ id, user_id: U, status: "confirmed" }));
  db.current.tables.recovery_approvals = G.slice(0, guardians).map((guardian_id) => ({
    request_id: R, guardian_id, approved_at: null, code_hash: createHash("sha256").update(CODE).digest("hex"),
  }));
  db.current.tables.recovery_settings = [];
}
const approveOnce = () =>
  approve(new NextRequest("http://enki.test/api/recovery/approve", {
    method: "POST",
    body: JSON.stringify({ requestId: R, guardianId: G[0], code: CODE }),
  }));
const status = () => db.current!.tables.recovery_requests[0].status;

beforeEach(() => owner(1));

describe("a recovery", () => {
  it("completes with the only confirmed guardian, whatever the stored threshold", async () => {
    const res = await approveOnce();
    expect(await res.json()).toMatchObject({ approved: 1, threshold: 1 });
    expect(status()).toBe("approved");
  });

  it("still needs two of two", async () => {
    owner(2);
    expect(await (await approveOnce()).json()).toMatchObject({ approved: 1, threshold: 2 });
    expect(status()).toBe("pending");
  });

  it("is never eased by guardians that cannot be counted", async () => {
    db.current!.state.failing = { table: "recovery_guardians", code: "XX000" };
    expect(await (await approveOnce()).json()).toMatchObject({ approved: 1, threshold: 2 });
    expect(status()).toBe("pending");
  });
});
