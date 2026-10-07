import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { citext } from "@electric-sql/pglite/contrib/citext";

/**
 * migrations/2026-09-24-search.sql run in a real Postgres (PGlite) on the
 * live shape it relies on (re-probed 2026-10-07): what search may find, what
 * it may never find, and who may call it at all.
 */

const SQL = readFileSync(join(__dirname, "..", "..", "migrations", "2026-09-24-search.sql"), "utf8");
const ARTIST = "11111111-1111-4111-8111-111111111111";
const BANNED = "22222222-2222-4222-8222-222222222222";
const BUYER = "33333333-3333-4333-8333-333333333333";
const ADULT_ONLY = "44444444-4444-4444-8444-444444444444";
const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

describe("the search SQL", () => {
  let db: PGlite;
  const prompts = async (q: string, showAdult = false) =>
    (await db.query<{ id: string }>("select id from search_prompts($1, 20, 0, $2)", [q, showAdult])).rows.map((r) => r.id);
  const titles = async (q: string, showAdult = false) =>
    (await db.query<{ title: string }>("select title from suggest_titles($1, 20, $2)", [q, showAdult])).rows.map((r) => r.title);
  const creators = async (q: string, showAdult = false) =>
    (await db.query<{ handle: string }>("select handle from search_creators($1, 20, $2)", [q, showAdult])).rows.map((r) => r.handle);

  beforeAll(async () => {
    db = await PGlite.create({ extensions: { pg_trgm, citext } });
    // Supabase's roles and default privileges hand every new function to
    // anon and authenticated unless the migration takes it back; the service
    // role reads every table.
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
        opens bigint not null default 0, is_adult boolean not null default false,
        encrypted_content text
      );
      create table public.bans (user_id uuid, lifted_at timestamptz, expires_at timestamptz);
      grant select on all tables in schema public to service_role, anon, authenticated;
      insert into public.users (id, handle, display_name) values
        ('${ARTIST}', 'brassworks', 'Brass Works'), ('${BANNED}', 'banned_artist', 'Banned'),
        ('${BUYER}', 'brassbuyer', 'Never Published'), ('${ADULT_ONLY}', 'brassnight', 'Night Shelf');
      insert into public.bans (user_id) values ('${BANNED}');
      insert into public.prompts (id, creator_id, title, description, tags, encrypted_content, is_listed, listing_status, deleted_at, is_adult, opens) values
        ('${id(1)}', '${ARTIST}', 'Brass Astrolabe Study', 'An instrument on linen', '{astrolabe,"still life"}', 'ciphertext-zebrafinch', true, 'active', null, false, 5),
        ('${id(2)}', '${ARTIST}', 'Velvet Boudoir', 'Evening portrait', '{woman}', null, true, 'active', null, true, 1),
        ('${id(3)}', '${ARTIST}', 'Brass Draft', null, '{astrolabe}', null, false, 'draft', null, false, 0),
        ('${id(4)}', '${ARTIST}', 'Brass Deleted', null, '{astrolabe}', null, true, 'active', now(), false, 0),
        ('${id(5)}', '${BANNED}', 'Brass Banned', null, '{astrolabe}', null, true, 'active', null, false, 0),
        ('${id(6)}', '${ADULT_ONLY}', 'Brass Nightfall', null, '{astrolabe}', null, true, 'active', null, true, 0);
    `);
    await db.exec(SQL);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("finds a prompt by its tags and by a near title", async () => {
    expect(await prompts("still life")).toEqual([id(1)]);
    expect(await prompts("Brass Astrolabbe Studdy")).toContain(id(1)); // a typo full text cannot match
  });

  it("never reaches the encrypted body", async () => {
    expect(await prompts("zebrafinch")).toEqual([]);
  });

  it("finds drafts, deleted prompts and a banned creator's prompts never", async () => {
    const found = await prompts("astrolabe", true);
    expect(found).toContain(id(1));
    for (const hidden of [id(3), id(4), id(5)]) expect(found).not.toContain(hidden);
  });

  it("shows 18+ only when the server says the viewer asked for it", async () => {
    expect(await prompts("velvet boudoir")).toEqual([]);
    expect(await prompts("velvet boudoir", true)).toEqual([id(2)]);
    expect(await titles("velvet")).toEqual([]);
    expect(await titles("velvet", true)).toEqual(["Velvet Boudoir"]);
  });

  it("suggests by prefix and treats a typed % or _ as a character", async () => {
    expect(await titles("brass astro")).toEqual(["Brass Astrolabe Study"]);
    expect(await titles("%")).toEqual([]);
    expect(await titles("_rass")).toEqual([]);
  });

  it("lists only creators with a listed prompt the viewer may see, never a banned one", async () => {
    expect(await creators("brass")).toEqual(["brassworks"]);
    expect((await creators("brass", true)).sort()).toEqual(["brassnight", "brassworks"]);
    expect(await creators("banned")).toEqual([]);
  });

  it("answers the service role and nobody holding the browser key", async () => {
    await db.exec("set role service_role");
    expect((await db.query("select id from search_prompts('astrolabe', 5, 0, false)")).rows.length).toBe(1);
    await db.exec("reset role");
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      for (const call of [
        "select * from search_prompts('astrolabe', 5, 0, false)",
        "select * from suggest_titles('brass', 5, false)",
        "select * from search_creators('brass', 5, false)",
      ]) {
        await expect(db.query(call), `${role}: ${call}`).rejects.toThrow(/permission denied/);
      }
      await db.exec("reset role");
    }
  });
});
