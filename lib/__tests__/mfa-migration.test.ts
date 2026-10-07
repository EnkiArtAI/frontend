import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * migrations/2026-10-07-mfa-factors.sql in a real Postgres, on Supabase's
 * roles and default privileges: one factor per user and kind, only the two
 * kinds, gone with the user, and invisible to the browser key.
 */

const SQL = readFileSync(join(__dirname, "..", "..", "migrations", "2026-10-07-mfa-factors.sql"), "utf8");
const U = "11111111-1111-4111-8111-111111111111";
const row = (kind: string) =>
  `insert into public.mfa_factors (user_id, kind, secret_ct, secret_iv, secret_tag, secret_kid) values ('${U}', '${kind}', 'ct', 'iv', 'tag', 'field-v1')`;

describe("the mfa_factors migration", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      create table public.users (id uuid primary key);
      insert into public.users (id) values ('${U}');
    `);
    await db.exec(SQL);
    await db.exec(SQL); // runs twice without harm
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("keeps one factor per user and kind, of the two kinds only", async () => {
    await db.exec(row("totp"));
    await expect(db.exec(row("totp"))).rejects.toThrow(/unique|duplicate/i);
    await expect(db.exec(row("sms"))).rejects.toThrow(/check/i);
    await db.exec(row("email"));
  });

  it("starts every counter at zero", async () => {
    const r = (await db.query<{ failed_attempts: number; lockouts: number; sends_count: number; confirmed_at: string | null }>(
      `select failed_attempts, lockouts, sends_count, confirmed_at from public.mfa_factors where kind = 'totp'`)).rows[0];
    expect(r).toEqual({ failed_attempts: 0, lockouts: 0, sends_count: 0, confirmed_at: null });
  });

  it("hides every row from anon and authenticated", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await expect(db.query("select id from public.mfa_factors"), role).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
    }
  });

  it("goes with its user", async () => {
    await db.exec(`delete from public.users where id = '${U}'`);
    expect((await db.query("select id from public.mfa_factors")).rows).toEqual([]);
  });
});
