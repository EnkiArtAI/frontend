import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * ENG-20. The free allowance was counted from generations rows written after
 * the response: parallel requests all read "2 used" and all rendered, and a
 * failed insert was never counted. It is now claimed in the database before
 * the render and given back only when nothing was rendered.
 */

const ROOT = join(__dirname, "..", "..");
const MIGRATION = readFileSync(join(ROOT, "migrations", "2026-10-06-free-generation-claims.sql"), "utf8");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("the migration", () => {
  let db: PGlite;
  const claim = async (user: string, limit = 3) =>
    (await db.query<{ id: string | null }>("select public.claim_free_generation($1, $2) as id", [user, limit])).rows[0].id;
  const claims = async (user: string) =>
    Number((await db.query<{ n: number }>("select count(*)::int as n from public.free_generation_claims where user_id = $1", [user])).rows[0].n);

  beforeAll(async () => {
    db = await PGlite.create();
    // The live shape it relies on (probed 2026-10-06), plus Supabase's roles.
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.users (id uuid primary key default gen_random_uuid());
      create table public.generations (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references public.users(id),
        amount_paid_cents integer,
        created_at timestamptz not null default now()
      );
      insert into public.users (id) values ('${A}'), ('${B}');
      insert into public.generations (user_id, amount_paid_cents) values ('${A}', null), ('${A}', null), ('${A}', 7), ('${B}', 5);
    `);
    await db.exec(MIGRATION);
    // PGlite boots a whole Postgres; under a full parallel run that takes longer than the default hook timeout.
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it("counts every free generation already made as a claim spent, and no paid one", async () => {
    expect(await claims(A)).toBe(2);
    expect(await claims(B)).toBe(0);
  });

  it("is idempotent: a second run backfills nothing twice", async () => {
    await db.exec(MIGRATION);
    expect(await claims(A)).toBe(2);
  });

  it("claims up to the limit and then returns null without inserting", async () => {
    expect(await claim(A)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await claim(A)).toBeNull();
    expect(await claims(A)).toBe(3);
    for (let i = 0; i < 3; i++) expect(await claim(B)).not.toBeNull();
    expect(await claim(B)).toBeNull();
    expect(await claims(B)).toBe(3);
  });

  it("serialises claims per account with a transaction-scoped lock", () => {
    expect(MIGRATION).toMatch(/PERFORM pg_advisory_xact_lock\(hashtextextended\('free_generation_claims:' \|\| p_user_id::text, 0\)\);\s+IF \(SELECT count\(\*\)/);
  });

  it("is callable by the service role only", async () => {
    const grants = await db.query<{ grantee: string }>(
      "select grantee from information_schema.routine_privileges where routine_name = 'claim_free_generation' and privilege_type = 'EXECUTE'",
    );
    const who = grants.rows.map((r) => r.grantee);
    expect(who).toContain("service_role");
    expect(who).not.toContain("anon");
    expect(who).not.toContain("authenticated");
    expect(who).not.toContain("PUBLIC");
  });
});

describe("the free route", () => {
  const FREE = readSource(join(ROOT, "app", "api", "generate-free", "route.ts"));

  it("claims before the render, on every database, with no branch that skips it", () => {
    const claimed = FREE.search(/const decision = await freeGenerationDecision\(supabaseForChecks, quotaUserId\);/);
    const render = FREE.search(/await generateImageWithPollinations\(/);
    expect(claimed).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(claimed);
    expect(FREE).not.toMatch(/if \(quotaClient\)/);
  });

  it("gives the claim back on every path that renders nothing", () => {
    expect(FREE).toMatch(/if \(silent\) \{\s+await releaseFreeClaim\(supabaseForChecks, claimId\);\s+return silentFailure\(\);/);
    expect(FREE).toMatch(/error: result\.error \|\| "Image generation failed" \}\)\);\s+await releaseFreeClaim\(supabaseForChecks, claimId\);/);
    expect(FREE).toMatch(/\} catch \(e: unknown\) \{[\s\S]{0,300}await releaseFreeClaim\(getSupabaseServerClientSafe\(\), claimId\);/);
    expect((FREE.match(/releaseFreeClaim\(/g) ?? []).length).toBe(3);
  });
});
