/** Offline daily-quota contract checks. Run: node scripts/free-daily-quota-checks.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

export const dailyQuotaSql = fs.readFileSync(new URL('../migrations/2026-10-12-free-daily-quota.sql', import.meta.url), 'utf8');
const priorSql = fs.readFileSync(new URL('../migrations/2026-10-06-free-generation-claims.sql', import.meta.url), 'utf8');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

export async function checkFreeDailyQuota(sql = dailyQuotaSql) {
  const db = await PGlite.create();
  // PGlite caches native built-in clock function execution. Inject only the
  // clock dependency in this TEST copy; UTC bounds, lock and cap stay unchanged.
  const testSql = sql.replaceAll('clock_timestamp()', 'public.fixture_clock_timestamp()');
  let passed = 0;
  const one = async (query, args = []) => (await db.query(query, args)).rows[0];
  const claim = async (user, limit = 1) => (await one('SELECT public.claim_free_generation($1,$2) AS id', [user, limit])).id;
  const quota = user => one('SELECT * FROM public.free_generation_quota($1)', [user]);
  const clock = value => db.query('UPDATE public.fixture_clock SET at=$1', [value]);
  const check = async body => { await body(); passed++; };
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
      CREATE TABLE public.fixture_clock (at timestamptz NOT NULL);
      INSERT INTO public.fixture_clock VALUES ('2026-10-12T12:00:00Z');
      CREATE FUNCTION public.fixture_clock_timestamp() RETURNS timestamptz
        LANGUAGE sql VOLATILE AS $$ SELECT at FROM public.fixture_clock $$;
      CREATE OR REPLACE FUNCTION pg_catalog.now() RETURNS timestamptz
        LANGUAGE sql STABLE AS $$ SELECT at FROM public.fixture_clock $$;
      CREATE TABLE public.users (id uuid PRIMARY KEY);
      CREATE TABLE public.generations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.users(id), provider text,
        created_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO public.users VALUES ('${A}'), ('${B}'), ('${C}');
      INSERT INTO public.generations (user_id,provider,created_at) VALUES
        ('${A}','pollinations','2026-10-11T23:59:59.999Z'),
        ('${A}','openai','2026-10-12T00:00:00Z');
    `);
    await db.exec(priorSql);
    await db.exec(testSql);
    await db.exec(testSql);

    await check(async () => {
      // Historical images remain in the ledger without spending today's slot.
      const row = await quota(A);
      assert.equal(row.used, 0);
      assert.equal(row.limit, 1);
      assert.equal(row.remaining, 1);
      assert.equal(row.exhausted, false);
      assert.equal(row.resets_at.toISOString(), '2026-10-13T00:00:00.000Z');
      assert.equal(Number((await one('SELECT count(*) AS n FROM public.free_generation_claims')).n), 1);
    });

    await check(async () => {
      assert.ok(await claim(A));
      assert.equal(await claim(A), null);
      assert.equal((await quota(A)).used, 1);
      assert.equal((await quota(A)).remaining, 0);
    });

    await check(async () => {
      // A rolling old server that asks for 3 must still be capped at 1.
      assert.ok(await claim(B, 3));
      assert.equal(await claim(B, 3), null);
      assert.equal((await quota(B)).used, 1);
    });

    await check(async () => {
      for (const limit of [0, -1, null]) assert.equal(await claim(C, limit), null);
      assert.equal(await claim(null, 1), null);
      assert.equal((await quota(C)).used, 0);
    });

    await check(async () => {
      // This burst is serialized by the in-process PostgreSQL runner. The SQL
      // account lock is separately checked below; this is not a multi-connection test.
      const result = await Promise.all(Array.from({ length: 10 }, () => claim(C)));
      assert.equal(result.filter(Boolean).length, 1);
    });

    await check(async () => {
      await db.query('DELETE FROM public.generations WHERE user_id=$1', [A]);
      assert.equal(await claim(A), null);
      assert.equal((await quota(A)).used, 1);
    });

    await check(async () => {
      // Only the failed render's own claim is released by the trusted server.
      await db.query('DELETE FROM public.free_generation_claims WHERE user_id=$1', [C]);
      assert.equal((await quota(C)).remaining, 1);
      assert.ok(await claim(C));
      assert.equal(await claim(C), null);
    });

    await check(async () => {
      // Exactly midnight starts a new UTC day, regardless of the DB session zone.
      await db.exec("SET TIME ZONE 'America/Los_Angeles'");
      await clock('2026-10-13T00:00:00Z');
      assert.equal((await quota(A)).remaining, 1);
      assert.equal((await quota(A)).resets_at.toISOString(), '2026-10-14T00:00:00.000Z');
      assert.ok(await claim(A));
      assert.equal(await claim(A), null);
      const row = await one('SELECT max(created_at) AS at FROM public.free_generation_claims WHERE user_id=$1', [A]);
      assert.equal(row.at.toISOString(), '2026-10-13T00:00:00.000Z');
    });

    await check(async () => {
      await clock('2026-11-01T00:00:00Z'); // US DST change is still a 24-hour UTC quota.
      assert.equal((await quota(A)).resets_at.toISOString(), '2026-11-02T00:00:00.000Z');
      assert.ok(await claim(A));
      await clock('2026-11-01T23:59:59.999Z');
      assert.equal(await claim(A), null);
      await clock('2026-11-02T00:00:00Z');
      assert.ok(await claim(A));
    });

    await check(async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        await assert.rejects(() => claim(A), error => error.code === '42501');
        await assert.rejects(() => quota(A), error => error.code === '42501');
        await assert.rejects(() => db.query('SELECT * FROM public.free_generation_claims'), error => error.code === '42501');
        await db.exec('RESET ROLE');
      }
      await db.exec('SET ROLE service_role');
      assert.equal((await quota(A)).limit, 1);
      await db.exec('RESET ROLE');
    });

    await check(async () => {
      const body = (await one(`SELECT prosrc FROM pg_proc WHERE oid='public.claim_free_generation(uuid,integer)'::regprocedure`)).prosrc;
      const lock = body.indexOf('PERFORM pg_advisory_xact_lock');
      const admissionClock = body.indexOf('v_now := public.fixture_clock_timestamp()');
      const count = body.indexOf('IF (SELECT count(*)');
      assert.ok(lock >= 0 && lock < admissionClock && admissionClock < count);
      assert.match(body, /free_generation_claims:' \|\| p_user_id::text/);
    });

    return { passed };
  } finally { await db.close(); }
}

export function freeDailyQuotaMutants(sql = dailyQuotaSql) {
  const lifetime = sql.replace('        AND created_at >= v_day_start\n        AND created_at < v_day_start + interval \'24 hours\'', '');
  const oldLimit = sql.replace('>= LEAST(p_limit, 1)', '>= p_limit');
  assert.notEqual(lifetime, sql);
  assert.notEqual(oldLimit, sql);
  return [{ name: 'lifetime count instead of UTC day', sql: lifetime }, { name: 'old caller can request three free images', sql: oldLimit }];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  globalThis.fetch = async () => { throw new Error('HTTP calls are forbidden in quota tests'); };
  const result = await checkFreeDailyQuota();
  console.log(`PASS ${result.passed} daily-quota SQL checks (offline PostgreSQL)`);
  if (process.argv.includes('--mutants')) {
    for (const mutant of freeDailyQuotaMutants()) {
      await assert.rejects(() => checkFreeDailyQuota(mutant.sql));
      console.log(`KILLED ${mutant.name}`);
    }
  }
}
