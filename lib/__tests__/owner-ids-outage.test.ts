import { describe, it, expect, beforeEach } from "vitest";
import { fakePostgrest } from "./_fake-postgrest";
import { resolveOwnerIds } from "@/lib/session-user";
import { DbUnreachableError } from "@/lib/db-error";

/**
 * Who owns a prompt (resolveOwnerIds) reads the session twice and the wallet
 * once. A dead database on any of them is an outage the caller answers with
 * 503, never "this session owns nothing" (a 404 on the creator's own prompt).
 */

const USER = "aaaaaaaa-0000-4000-8000-0000000000aa";
const later = new Date(Date.now() + 86_400_000).toISOString();
let db: ReturnType<typeof fakePostgrest>;

beforeEach(() => {
  db = fakePostgrest();
  db.tables.auth_sessions = [{ token: "tok", wallet_address: USER, expires_at: later }];
  db.tables.bans = [];
  db.tables.user_wallets = [];
});

describe("resolveOwnerIds", () => {
  it("names the session's account", async () => {
    expect(await resolveOwnerIds(db.client as never, "tok")).toEqual([USER]);
  });

  it("throws an outage when the second session read meets a dead database", async () => {
    db.state.failNext = { table: "auth_sessions", op: "select", code: "ECONNREFUSED", skip: 1 };
    await expect(resolveOwnerIds(db.client as never, "tok")).rejects.toBeInstanceOf(DbUnreachableError);
  });

  it("throws an outage when the wallet read meets a dead database", async () => {
    db.state.failNext = { table: "user_wallets", op: "select", code: "ECONNREFUSED" };
    await expect(resolveOwnerIds(db.client as never, "tok")).rejects.toBeInstanceOf(DbUnreachableError);
  });

  it("still reads another failure as no owner, as before", async () => {
    db.state.failNext = { table: "auth_sessions", op: "select", code: "PGRST000", skip: 1 };
    expect(await resolveOwnerIds(db.client as never, "tok")).toBeNull();
  });
});
