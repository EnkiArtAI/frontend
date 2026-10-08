import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { citext } from "@electric-sql/pglite/contrib/citext";

/**
 * migrations/2026-10-08-search-hide-deleted-creators.sql on top of the search
 * migration, in a real Postgres (PGlite): a deleted or inactive account's
 * prompts leave the search and the title suggestions, as a banned one's
 * already did, and the functions still answer only the service role.
 */

const read = (name: string) => readFileSync(join(__dirname, "..", "..", "migrations", name), "utf8");
const ARTIST = "11111111-1111-4111-8111-111111111111";
const GONE = "22222222-2222-4222-8222-222222222222";
const SUSPENDED = "33333333-3333-4333-8333-333333333333";
// Deleted while the status still reads active: either mark alone hides.
const ERASED = "44444444-4444-4444-8444-444444444444";
const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

describe("search without deleted or inactive creators", () => {
  let db: PGlite;
  const prompts = async (q: string) =>
    (await db.query<{ id: string }>("select id from search_prompts($1, 20, 0, false, null)", [q])).rows.map((r) => r.id).sort();
  const titles = async (q: string) =>
    (await db.query<{ title: string }>("select title from suggest_titles($1, 20, false)", [q])).rows.map((r) => r.title).sort();

  beforeAll(async () => {
    db = await PGlite.create({ extensions: { pg_trgm, citext } });
    await db.exec(`
      create extension citext;
      create role anon; create role authenticated; create role service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
      create table public.users (
        id uuid primary key, handle public.citext, display_name text, avatar_url text,
        account_status text not null default 'active', deleted_at timestamptz
      );
      create table public.prompts (
        id uuid primary key, creator_id uuid references public.users(id), title text, description text,
        tags text[] not null default '{}', is_listed boolean not null default true,
        listing_status text not null default 'active', deleted_at timestamptz,
        opens bigint not null default 0, is_adult boolean not null default false, ai_model text,
        encrypted_content text
      );
      create table public.bans (user_id uuid, lifted_at timestamptz, expires_at timestamptz);
      grant select on all tables in schema public to service_role, anon, authenticated;
      insert into public.users (id, handle, account_status, deleted_at) values
        ('${ARTIST}', 'brassworks', 'active', null),
        ('${GONE}', 'gone_artist', 'deleted', now()),
        ('${SUSPENDED}', 'paused_artist', 'suspended', null),
        ('${ERASED}', 'erased_artist', 'active', now());
      insert into public.prompts (id, creator_id, title, tags) values
        ('${id(1)}', '${ARTIST}', 'Brass Astrolabe', '{astrolabe}'),
        ('${id(2)}', '${GONE}', 'Brass Orrery', '{astrolabe}'),
        ('${id(3)}', '${SUSPENDED}', 'Brass Sextant', '{astrolabe}'),
        ('${id(4)}', '${ERASED}', 'Brass Telescope', '{astrolabe}');
    `);
    await db.exec(read("2026-09-24-search.sql"));
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("before this migration, a deleted or suspended creator's prompts were still found", async () => {
    expect(await prompts("astrolabe")).toEqual([id(1), id(2), id(3), id(4)]);
    expect(await titles("brass")).toEqual(["Brass Astrolabe", "Brass Orrery", "Brass Sextant", "Brass Telescope"]);
  });

  it("after it, only the active creator's prompt is found or suggested", async () => {
    await db.exec(read("2026-10-08-search-hide-deleted-creators.sql"));
    expect(await prompts("astrolabe")).toEqual([id(1)]);
    expect(await titles("brass")).toEqual(["Brass Astrolabe"]);
  });

  it("still answers the service role and nobody holding the browser key", async () => {
    await db.exec("set role service_role");
    expect((await db.query("select id from search_prompts('astrolabe', 5, 0, false, null)")).rows.length).toBe(1);
    await db.exec("reset role");
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      for (const call of ["select * from search_prompts('astrolabe', 5, 0, false, null)", "select * from suggest_titles('brass', 5, false)"]) {
        await expect(db.query(call), `${role}: ${call}`).rejects.toThrow(/permission denied/);
      }
      await db.exec("reset role");
    }
  });
});
