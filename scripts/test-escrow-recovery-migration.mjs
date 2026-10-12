/**
 * Offline PostgreSQL migration check. Run: npm run test:migrations
 * --postgres additionally proves lock contention in the empty, loopback-only
 * enki_escrow_test database created by CI. The default uses no network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { checkEscrowDeposits } from './escrow-deposit-migration-checks.mjs';
import { checkEscrowUnits } from './escrow-unit-migration-checks.mjs';
import { checkEscrowTransactions } from './escrow-settlement-migration-checks.mjs';

globalThis.fetch = async () => { throw new Error('HTTP calls are forbidden in migration tests'); };
const postgres = process.argv.includes('--postgres');
let pgOptions;
let db;
if (postgres) {
  const uri = new URL(process.env.ENKI_ESCROW_TEST_DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(uri.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname));
  assert.equal(uri.pathname, '/enki_escrow_test');
  assert.equal(uri.search, ''); assert.equal(uri.hash, '');
  assert.ok(uri.port);
  pgOptions = { host: uri.hostname.replace(/^\[|\]$/g,''), port: Number(uri.port),
    database: 'enki_escrow_test', user: decodeURIComponent(uri.username),
    password: decodeURIComponent(uri.password), ssl: false, connectionTimeoutMillis: 10_000 };
  const client = new pg.Client(pgOptions); await client.connect();
  db = { query: (text, args) => client.query(text, args),
    exec: text => client.query(text), close: () => client.end() };
} else {
  db = await PGlite.create();
}
const base = new URL('./fixtures/escrow-recovery-live-schema.sql', import.meta.url);
const migrationPath = new URL('../migrations/2026-10-05-escrow-recovery-reservations.sql', import.meta.url);
const sql = fs.readFileSync(migrationPath, 'utf8');
const devMint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const mainMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let passed = 0;
let nextId = 1;
const id = () => `00000000-0000-0000-0000-${String(nextId++).padStart(12, '0')}`;
const row = async (sqlText, parameters = []) => (await db.query(sqlText, parameters)).rows[0];
const money = value => Number(value);
async function intent(artist = 'artist-one', total = 1_000_000, share = 100_000, status = 'quoted') {
  const intentId = id();
  await db.query(`INSERT INTO public.generation_payment_intents
    (id,buyer_wallet,model_family,artist_wallet,artist_amount_micro,model_cost_micro,
     enki_fee_micro,total_micro,fee_bps,fee_base,fee_mode,status,expires_at)
    VALUES ($1,'buyer-test','fixture',$2,$3,$4,0,$5,1000,'model','on_top',$6,'2100-01-01')`,
  [intentId, artist, share, total-share, total, status]);
  return intentId;
}
async function front(artist, amount, mint = devMint) {
  await db.query(`INSERT INTO public.artist_cost_ledger (artist_wallet,mint,entry,micro,lamports)
    VALUES ($1,$2,'fronted',$3,2039280)`, [artist,mint,amount]);
}
// Fixture of a verified Config read; never a production fallback or SQL default.
const configCap = 50_000_000;
async function reserve(intentId, units = 4, mint = devMint, cap = configCap) {
  return row('SELECT * FROM public.reserve_generation_escrow_recovery($1,$2,$3,$4)', [intentId,units,mint,cap]);
}
async function funded(intentId) {
  await db.query(`UPDATE public.generation_payment_intents
    SET deposit_signature='verified-deposit-fixture',deposit_confirmed_at='2026-10-05' WHERE id=$1`, [intentId]);
}
const confirm = (intentId, k, signature = 'verified-settlement-fixture') =>
  row('SELECT * FROM public.confirm_generation_escrow_recovery($1,$2,$3)', [intentId,k,signature]);
const cancel = intentId => row('SELECT * FROM public.cancel_unfunded_generation_escrow_recovery($1)', [intentId]);
async function rejects(operation, code = '22023') {
  await assert.rejects(operation, error => error.code === code);
}
async function check(name, body) {
  await body(); passed++; console.log(`PASS ${name}`);
}

try {
  if (postgres) {
    const existing = await row(`SELECT count(*) AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p')`);
    assert.equal(money(existing.n),0,'The PostgreSQL fixture database must be empty');
  }
  await db.exec(fs.readFileSync(base, 'utf8'));
  // Mock the database clock too; expiry tests never depend on today's date.
  await db.exec(`CREATE OR REPLACE FUNCTION pg_catalog.now() RETURNS timestamptz
    LANGUAGE sql STABLE AS $$ SELECT '2026-10-05T00:00:00Z'::timestamptz $$`);
  await db.exec(sql);
  await db.exec(sql); // Applying the migration twice must preserve its contracts.
  await check('rerun and service-only permissions', async () => {
    assert.equal((await row('SELECT now() AS clock')).clock.toISOString(),'2026-10-05T00:00:00.000Z');
    for (const role of ['anon','authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await rejects(() => reserve(id()), '42501');
      await rejects(() => confirm(id(),0), '42501');
      await rejects(() => cancel(id()), '42501');
      await rejects(() => db.query('SELECT * FROM public.generation_escrow_recovery'), '42501');
      await db.exec('RESET ROLE');
    }
    await db.exec('SET ROLE service_role');
    await db.query('SELECT * FROM public.generation_escrow_recovery');
    await rejects(() => db.query('DELETE FROM public.generation_escrow_recovery'), '42501');
    await db.exec('RESET ROLE');
  });
  await check('open reservations exclude already reserved debt', async () => {
    await front('artist-one',150_000);
    const firstId = await intent(); const secondId = await intent();
    await db.exec('SET ROLE service_role');
    const first = await reserve(firstId); const second = await reserve(secondId);
    assert.equal(money(first.recovery_unit_micro),37_500);
    assert.equal(money(first.reserved_micro),150_000);
    assert.equal(money(second.reserved_micro),0);
    assert.equal(money(first.treasury_unit_micro)+money(first.artist_unit_micro),1_000_000);
    assert.equal(money(first.artist_unit_micro),62_500);
    assert.deepEqual(await reserve(firstId),first);
    await rejects(() => reserve(firstId,3));
    await rejects(() => reserve(firstId,4,mainMint));
    await db.exec('RESET ROLE');
    assert.equal(money((await row("SELECT count(*) AS n FROM public.artist_cost_ledger WHERE entry='recovered'")).n),0);
  });
  await check('partial confirmed delivery books k*r once and releases (N-k)*r', async () => {
    // Use the reservation itself, rather than depending on fixture ID allocation.
    const first = await row("SELECT intent_id FROM public.generation_escrow_recovery WHERE artist_wallet='artist-one' AND reserved_micro=150000");
    await rejects(() => confirm(first.intent_id,2));
    await funded(first.intent_id);
    const booked = await confirm(first.intent_id,2);
    assert.equal(booked.state,'confirmed');
    assert.deepEqual(await confirm(first.intent_id,2),booked);
    await rejects(() => confirm(first.intent_id,3));
    await rejects(() => confirm(first.intent_id,2,'different-receipt'));
    const ledger = await row("SELECT count(*) AS n,sum(micro) AS micro FROM public.artist_cost_ledger WHERE entry='recovered' AND intent_id=$1",[first.intent_id]);
    assert.equal(money(ledger.n),1); assert.equal(money(ledger.micro),75_000);
    assert.equal(money((await reserve(await intent())).reserved_micro),75_000);
    await rejects(() => cancel(first.intent_id));
    await rejects(() => reserve(first.intent_id));
  });
  await check('expiry cancellation requires an unfunded terminal intent', async () => {
    await front('artist-cancel',150_000);
    const pending = await intent('artist-cancel'); await reserve(pending);
    await rejects(() => cancel(pending));
    await db.query("UPDATE public.generation_payment_intents SET status='expired' WHERE id=$1",[pending]);
    const released = await cancel(pending); assert.equal(released.state,'released');
    assert.deepEqual(await cancel(pending),released);
    await rejects(() => reserve(pending));
    assert.equal(money((await reserve(await intent('artist-cancel'))).reserved_micro),150_000);
    await rejects(() => confirm(pending,0));
    const active = await intent('artist-cancel'); await reserve(active); await funded(active);
    await db.query("UPDATE public.generation_payment_intents SET status='expired' WHERE id=$1",[active]);
    await rejects(() => cancel(active));
  });
  await check('integer rounding floors half-share and available debt per unit', async () => {
    await front('artist-round',150_003);
    const first = await reserve(await intent('artist-round'),1);
    assert.equal(money(first.recovery_unit_micro),50_000);
    await front('artist-tiny-share',150_000);
    assert.equal(money((await reserve(await intent('artist-tiny-share',100,5),4)).recovery_unit_micro),2);
    await front('artist-tiny-debt',3);
    assert.equal(money((await reserve(await intent('artist-tiny-debt'),4)).recovery_unit_micro),0);
  });
  await check('half-share continues beyond four instalments until rent is recovered', async () => {
    await front('artist-many-instalments',350_003);
    for (let payment = 0; payment < 8; payment++) {
      const pending = await intent('artist-many-instalments');
      const reserved = await reserve(pending,1);
      assert.equal(money(reserved.recovery_unit_micro),payment < 7 ? 50_000 : 3);
      await funded(pending); await confirm(pending,1);
    }
    assert.equal(money((await reserve(await intent('artist-many-instalments'),1)).recovery_unit_micro),0);
    assert.equal(money((await row("SELECT sum(micro) AS micro FROM public.artist_cost_ledger WHERE artist_wallet='artist-many-instalments' AND entry='recovered'")).micro),350_003);
  });
  await check('only the supplied Chain Config cap bounds the whole deposit', async () => {
    const exact = await intent(null,12_500_000,0);
    assert.equal(money((await reserve(exact,4)).total_unit_micro)*4,configCap);
    await rejects(async () => reserve(await intent(null,12_500_001,0),4));
    // Config can change without an application/SQL release; there is no 25/50 cap here.
    const increased = await intent(null,60_000_000,0);
    await rejects(() => reserve(increased,1,devMint,configCap));
    assert.equal(money((await reserve(increased,1,devMint,60_000_000)).total_unit_micro),60_000_000);
    await rejects(async () => reserve(await intent(null,30_000_000,0),1,devMint,20_000_000));
    const invalidCapIntent = await intent(null,1,0);
    for (const cap of [null,0,-1]) await rejects(() => reserve(invalidCapIntent,1,devMint,cap));
    await rejects(() => row('SELECT * FROM public.reserve_generation_escrow_recovery($1,$2,$3)',
      [invalidCapIntent,1,devMint]),'42883'); // No overload/default bypasses the chain cap.
    const overflowing = await intent(null,1,0);
    await db.query('UPDATE public.generation_payment_intents SET total_micro=9223372036854775807 WHERE id=$1',[overflowing]);
    await rejects(() => reserve(overflowing,24)); // Reject by cap before bigint multiplication could overflow.
  });
  await check('mint, artist and prior over-recovery remain isolated', async () => {
    await front('artist-chain',150_000,mainMint);
    assert.equal(money((await reserve(await intent('artist-chain'))).reserved_micro),0);
    assert.equal(money((await reserve(await intent('artist-chain'),4,mainMint)).reserved_micro),150_000);
    await front('artist-over',3);
    await db.query("INSERT INTO public.artist_cost_ledger(artist_wallet,mint,entry,micro,intent_id) VALUES ('artist-over',$1,'recovered',4,$2)",[devMint,id()]);
    assert.equal(money((await reserve(await intent('artist-over'))).reserved_micro),0);
    const noArtist = await reserve(await intent(null,100,0));
    assert.equal(money(noArtist.treasury_unit_micro),100); assert.equal(money(noArtist.reserved_micro),0);
  });
  await check('invalid quantities, caps, mint and old nonce intents fail closed', async () => {
    const valid = await intent('artist-invalid');
    for (const units of [null,0,25,-1]) await rejects(() => reserve(valid,units));
    await rejects(() => reserve(valid,4,'other-mint'));
    await rejects(() => reserve(id()));
    await rejects(async () => reserve(await intent('artist-invalid',0,0)));
    await rejects(async () => reserve(await intent('artist-invalid',50_000_001,0),1));
    await rejects(async () => reserve(await intent('artist-invalid',13_000_000,0),4));
    await rejects(async () => reserve(await intent(null,Number.MAX_SAFE_INTEGER,0),24));
    await rejects(async () => reserve(await intent(null,100,10)));
    const nonce = await intent('artist-invalid');
    await db.query("UPDATE public.generation_payment_intents SET nonce_account='legacy-nonce' WHERE id=$1",[nonce]);
    await rejects(() => reserve(nonce));
    const expired = await intent('artist-invalid');
    await db.query("UPDATE public.generation_payment_intents SET expires_at='2020-01-01' WHERE id=$1",[expired]);
    await rejects(() => reserve(expired));
  });
  await check('k=0 releases all recovery without writing a zero ledger entry', async () => {
    await front('artist-zero',150_000);
    const pending = await intent('artist-zero'); await reserve(pending); await funded(pending);
    for (const k of [null,-1,5]) await rejects(() => confirm(pending,k));
    await rejects(() => confirm(pending,0,''));
    await confirm(pending,0);
    assert.equal(money((await row("SELECT count(*) AS n FROM public.artist_cost_ledger WHERE entry='recovered' AND artist_wallet='artist-zero'")).n),0);
    assert.equal(money((await reserve(await intent('artist-zero'))).reserved_micro),150_000);
  });
  await check('failed ledger insert rolls back reservation confirmation', async () => {
    await front('artist-collision',150_000);
    const pending = await intent('artist-collision'); await reserve(pending); await funded(pending);
    await db.query("INSERT INTO public.artist_cost_ledger(artist_wallet,mint,entry,micro,intent_id) VALUES ('artist-collision',$1,'recovered',1,$2)",[devMint,pending]);
    await rejects(() => confirm(pending,1),'23505');
    assert.equal((await row('SELECT state FROM public.generation_escrow_recovery WHERE intent_id=$1',[pending])).state,'reserved');
  });
  if (postgres) await check('parallel sessions wait for account lock and see committed reservation', async () => {
    await front('artist-parallel',150_000);
    const firstId = await intent('artist-parallel'); const secondId = await intent('artist-parallel');
    const holder = new pg.Client(pgOptions); const contender = new pg.Client(pgOptions);
    await holder.connect(); await contender.connect();
    let pending;
    try {
      await holder.query('BEGIN'); await contender.query('BEGIN');
      await contender.query("SET LOCAL statement_timeout='10s'");
      await holder.query('SELECT * FROM public.reserve_generation_escrow_recovery($1,4,$2,$3)',[firstId,devMint,configCap]);
      const lock = (await contender.query(`SELECT pg_try_advisory_xact_lock(
        hashtextextended('enki-escrow-recovery:artist-parallel:' || $1,0)) AS acquired`,[devMint])).rows[0];
      assert.equal(lock.acquired,false,'The reservation function must hold its account lock');
      const pid = (await contender.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = contender.query('SELECT * FROM public.reserve_generation_escrow_recovery($1,4,$2,$3)',[secondId,devMint,configCap])
        .then(result => ({result}), error => ({error}));
      let waiting = false;
      // Observe the lock state, not an elapsed-time guess, before committing A.
      for (let probe=0; probe<1000 && !waiting; probe++) {
        waiting = (await row(`SELECT EXISTS(SELECT 1 FROM pg_locks
          WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting`,[pid])).waiting;
      }
      assert.equal(waiting,true,'The second session must wait before reading debt');
      await holder.query('COMMIT');
      const completed = await pending;
      assert.equal(completed.error,undefined);
      assert.equal(money(completed.result.rows[0].reserved_micro),0);
      await contender.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK');
      if (pending) await pending;
      await contender.query('ROLLBACK');
      await holder.end(); await contender.end();
    }
  });
  const depositSql = fs.readFileSync(new URL('../migrations/2026-10-06-escrow-deposit-persistence.sql',import.meta.url),'utf8');
  await db.exec(depositSql);
  await db.exec(depositSql);
  await checkEscrowDeposits({db,row,check,rejects,id,intent,reserve,pgOptions});
  await db.exec(fs.readFileSync(new URL('./fixtures/escrow-generation-live-columns.sql',import.meta.url),'utf8'));
  const unitSql=fs.readFileSync(new URL('../migrations/2026-10-12-escrow-unit-claims.sql',import.meta.url),'utf8');
  await db.exec(unitSql); await db.exec(unitSql);
  const units=await checkEscrowUnits({db,row,check,rejects,id,intent,reserve,pgOptions});
  const transactionSql=fs.readFileSync(new URL('../migrations/2026-10-12-escrow-settlement-attempts.sql',import.meta.url),'utf8');
  await db.exec(transactionSql);await db.exec(transactionSql);
  await checkEscrowTransactions({db,row,check,rejects,id,units});
  console.log(`PASS ${passed} escrow migration checks; live database was not used.`);
} finally {
  await db.close();
}
