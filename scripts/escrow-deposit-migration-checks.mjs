import assert from 'node:assert/strict';
import pg from 'pg';

// Database transition tests. Signature/PDA cryptography is tested separately
// by the generated Kit client; these bytes deliberately are not RPC fixtures.
export async function checkEscrowDeposits({ db, row, check, rejects, id, intent, reserve, pgOptions }) {
  const address = char => char.repeat(32);
  const message = Buffer.from([2,0,4,6,...Array(200).fill(7)]);
  const unsigned = Buffer.concat([Buffer.from([2]),Buffer.alloc(128),message]);
  const signed = Buffer.concat([Buffer.from([2]),Buffer.alloc(64,8),Buffer.alloc(64,9),message]);
  const bytea = bytes => Buffer.from(bytes);
  const signature = address('S').repeat(2);
  const prepareSql = `SELECT * FROM public.prepare_generation_escrow_deposit(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`;
  const beginSql = 'SELECT * FROM public.begin_generation_escrow_submit($1,$2,$3,$4)';
  const storeSql = 'SELECT * FROM public.store_generation_escrow_signed_deposit($1,$2,$3,$4,$5)';
  const confirmSql = 'SELECT * FROM public.confirm_generation_escrow_deposit($1,$2,$3,$4)';
  const expireSql = 'SELECT * FROM public.expire_unfunded_generation_escrow_deposit($1,$2,$3,$4)';
  let nextAddress = 0;
  const args = (intentId, changes = {}) => {
    // Distinct per intent, so the canonical-address unique index is exercised.
    const suffix = String(++nextAddress).replaceAll('0','A');
    const fields = {
      intentId, owner: 'buyer-test', program: address('P'), cluster: 'solana-devnet',
      buyer: address('B'), sponsor: address('R'), treasury: address('T'),
      escrow: `${address('E')}${suffix}`, vault: `${address('V')}${suffix}`,
      unsigned: bytea(unsigned), message: bytea(message), blockhash: address('H'), height: 100,
      chainNow: 1_000_000, expiry: 1_000_900, ...changes,
    };
    return Object.values(fields);
  };
  const prepare = parameters => row(prepareSql,parameters);
  const begin = (intentId, token, height = 100, owner = 'buyer-test') =>
    row(beginSql,[intentId,owner,token,height]);
  const store = (intentId, token, bytes = signed, receipt = signature, owner = 'buyer-test') =>
    row(storeSql,[intentId,owner,token,bytea(bytes),receipt]);
  const confirm = (intentId, receipt = signature, slot = 123, owner = 'buyer-test') =>
    row(confirmSql,[intentId,owner,receipt,slot]);
  const expire = (intentId, height = 101, slot = 124, owner = 'buyer-test') =>
    row(expireSql,[intentId,owner,height,slot]);
  const pending = async (changes = {}) => {
    const intentId = await intent('artist-deposit',1_000_000,100_000);
    await reserve(intentId,4);
    const parameters = args(intentId,changes);
    return { intentId,parameters,prepared: await prepare(parameters) };
  };
  const state = intentId => row('SELECT * FROM public.generation_escrow_deposits WHERE intent_id=$1',[intentId]);
  const intentState = intentId => row('SELECT * FROM public.generation_payment_intents WHERE id=$1',[intentId]);

  await check('deposit rerun preserves service-only read and RPC privileges', async () => {
    for (const role of ['anon','authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await rejects(() => prepare(args(id())),'42501');
      await rejects(() => begin(id(),id()),'42501');
      await rejects(() => store(id(),id()),'42501');
      await rejects(() => confirm(id()),'42501');
      await rejects(() => expire(id()),'42501');
      await rejects(() => state(id()),'42501');
      await db.exec('RESET ROLE');
    }
    await db.exec('SET ROLE service_role');
    await state(id());
    for (const query of ['DELETE FROM public.generation_escrow_deposits',
      "UPDATE public.generation_escrow_deposits SET state='expired'",
      'INSERT INTO public.generation_escrow_deposits(intent_id) VALUES ($1)']) {
      await rejects(() => db.query(query,query.includes('$1') ? [id()] : []),'42501');
    }
    await db.exec('RESET ROLE');
    assert.equal((await row(`SELECT relrowsecurity FROM pg_class
      WHERE oid='public.generation_escrow_deposits'::regclass`)).relrowsecurity,true);
    const functions = (await db.query(`SELECT p.prosecdef,p.proconfig FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
      ('prepare_generation_escrow_deposit','begin_generation_escrow_submit',
       'store_generation_escrow_signed_deposit','confirm_generation_escrow_deposit',
       'expire_unfunded_generation_escrow_deposit')`)).rows;
    assert.equal(functions.length,5);
    for (const fn of functions) { assert.equal(fn.prosecdef,true); assert.deepEqual(fn.proconfig,['search_path=pg_catalog']); }
  });
  await check('deposit preparation keeps the first message and lifetime unchanged', async () => {
    const {intentId,prepared} = await pending();
    await db.exec('SET ROLE service_role');
    const retry = await prepare(args(intentId,{ blockhash:address('J'),height:200,expiry:1_001_800 }));
    assert.deepEqual(retry,prepared);
    assert.equal(prepared.state,'prepared'); assert.equal(prepared.signature,null);
    assert.equal(prepared.submission_token,null); assert.equal(prepared.signed_transaction,null);
    await rejects(() => prepare(args(intentId,{owner:'another-buyer'})));
    assert.equal(await begin(intentId,id(),100,'another-buyer'),undefined);
    await rejects(() => store(intentId,id(),signed,signature,'another-buyer'));
    await rejects(() => confirm(intentId,signature,123,'another-buyer'));
    await rejects(() => expire(intentId,101,124,'another-buyer'));
    await db.exec('RESET ROLE');
    assert.equal((await intentState(intentId)).status,'building');
    assert.equal((await intentState(intentId)).deposit_signature,null);
  });
  await check('deposit preparation requires the unchanged recovery quote and no legacy authorization', async () => {
    const noReservation = await intent(); await rejects(() => prepare(args(noReservation)));
    for (const patch of ["nonce_account='legacy'","authorized_at=now()","captured_at=now()",
      "voided_at=now()","consumed_at=now()","fulfilled_at=now()","status='confirmed'",
      "expires_at='2020-01-01'","deposit_signature='legacy'","deposit_confirmed_at=now()",
      'total_micro=total_micro+1','artist_amount_micro=artist_amount_micro+1',"artist_wallet='changed'"]) {
      const intentId = await intent(); await reserve(intentId);
      await db.query(`UPDATE public.generation_payment_intents SET ${patch} WHERE id=$1`,[intentId]);
      await rejects(() => prepare(args(intentId)));
      assert.equal(await state(intentId),undefined);
    }
    const mintMismatch = await intent(); await reserve(mintMismatch);
    await rejects(() => prepare(args(mintMismatch,{cluster:'solana'})));
  });
  await check('deposit wire, addresses, TTL and mandatory fields fail closed', async () => {
    const changedMessage = Buffer.from(message); changedMessage[4] = 8;
    const alreadySigned = Buffer.from(unsigned); alreadySigned[1] = 8;
    const changes = [
      { message:bytea(changedMessage) }, { unsigned:bytea(alreadySigned) },
      { unsigned:bytea(Buffer.concat([unsigned,Buffer.alloc(1)])) },
      { unsigned:bytea(Buffer.alloc(1233)) }, { message:bytea(Buffer.from([2])) },
      { buyer:address('R') }, { treasury:address('1') }, { program:'invalid-0' },
      { cluster:'solana-other' }, { height:0 }, { chainNow:-1 },
      { expiry:1_000_599 }, { expiry:1_001_801 },
    ];
    for (const change of changes) {
      const intentId = await intent(); await reserve(intentId);
      await rejects(() => prepare(args(intentId,change)),'23514');
      assert.equal(await state(intentId),undefined);
      assert.equal((await intentState(intentId)).status,'quoted');
    }
    const names = ['program','cluster','buyer','sponsor','treasury','escrow','vault',
      'unsigned','message','blockhash','height','chainNow','expiry'];
    for (const name of names) {
      const intentId = await intent(); await reserve(intentId);
      await rejects(() => prepare(args(intentId,{[name]:null})),'23502');
    }
    for (const expiry of [1_000_600,1_001_800]) assert.equal((await pending({expiry})).prepared.state,'prepared');
  });
  await check('only one submit wins, without token takeover or expired-blockhash signing', async () => {
    const {intentId} = await pending(); const token = id();
    assert.equal(await begin(intentId,null),undefined);
    assert.equal(await begin(intentId,id(),101),undefined);
    assert.equal(await begin(intentId,id(),null),undefined);
    assert.equal(await begin(intentId,id(),-1),undefined);
    assert.equal((await begin(intentId,token)).submission_token,token);
    assert.equal(await begin(intentId,id()),undefined);
    assert.equal(await begin(intentId,token),undefined);
    await rejects(() => store(intentId,id()));
    await rejects(() => store(intentId,null));
    assert.equal((await state(intentId)).signed_transaction,null);
    for (const patch of ["status='expired'","nonce_account='legacy'","authorized_at=now()",
      "consumed_at=now()","voided_at=now()","fulfilled_at=now()","captured_at=now()",
      "deposit_signature='legacy'","deposit_confirmed_at=now()"]) {
      const next = await pending();
      await db.query(`UPDATE public.generation_payment_intents SET ${patch} WHERE id=$1`,[next.intentId]);
      assert.equal(await begin(next.intentId,id()),undefined);
    }
  });
  await check('signed deposit persists once, requires both signature slots and unchanged message', async () => {
    const {intentId} = await pending(); const token = id();
    await rejects(() => store(intentId,token));
    await begin(intentId,token);
    const changed = Buffer.from(signed); changed[140] = 10;
    const buyerMissing = Buffer.from(signed); buyerMissing.fill(0,65,129);
    const sponsorMissing = Buffer.from(signed); sponsorMissing.fill(0,1,65);
    for (const bytes of [unsigned,changed,buyerMissing,sponsorMissing,Buffer.concat([signed,Buffer.alloc(1)])]) {
      await rejects(() => store(intentId,token,bytes),'23514');
      assert.equal((await state(intentId)).state,'submitting');
    }
    await rejects(() => store(intentId,token,signed,'invalid-signature-0'),'23514');
    const saved = await store(intentId,token);
    assert.equal(saved.state,'submitted'); assert.equal(saved.confirmed_at,null);
    assert.deepEqual(await store(intentId,token),saved);
    await rejects(() => store(intentId,token,changed));
    await rejects(() => store(intentId,token,signed,address('W').repeat(2)));
    assert.equal((await intentState(intentId)).status,'submitted');
    assert.equal((await intentState(intentId)).deposit_confirmed_at,null);
    assert.equal((await intentState(intentId)).deposit_signature,null);
  });
  await check('confirmation binds the stored signature and funds both rows atomically', async () => {
    const {intentId} = await pending(); const token = id(); const receipt = address('F').repeat(2);
    await rejects(() => confirm(intentId,receipt)); await begin(intentId,token);
    await rejects(() => confirm(intentId,receipt)); await store(intentId,token,signed,receipt);
    for (const slot of [null,0,-1]) await rejects(() => confirm(intentId,receipt,slot));
    await rejects(() => confirm(intentId,address('D').repeat(2)));
    const confirmed = await confirm(intentId,receipt);
    assert.equal(confirmed.state,'funded'); assert.equal(Number(confirmed.confirmed_slot),123);
    assert.deepEqual(await confirm(intentId,receipt,500),confirmed);
    assert.deepEqual(await store(intentId,token,signed,receipt),confirmed);
    const parent = await intentState(intentId);
    assert.equal(parent.status,'confirmed'); assert.equal(parent.deposit_signature,receipt);
    assert.deepEqual(parent.deposit_confirmed_at,confirmed.confirmed_at);
    assert.equal(await begin(intentId,id()),undefined);
    await rejects(() => expire(intentId));
    assert.equal((await row('SELECT state FROM public.generation_escrow_recovery WHERE intent_id=$1',[intentId])).state,'reserved');
  });
  await check('expiry retains audit bytes and atomically releases only unfunded recovery', async () => {
    for (const stage of ['prepared','submitting','submitted']) {
      const {intentId} = await pending(); const token = id();
      if (stage !== 'prepared') await begin(intentId,token);
      if (stage === 'submitted') await store(intentId,token,signed,address('X').repeat(2));
      for (const height of [null,99,100]) await rejects(() => expire(intentId,height));
      for (const slot of [null,0,-1]) await rejects(() => expire(intentId,101,slot));
      assert.equal((await state(intentId)).state,stage);
      const expired = await expire(intentId);
      assert.equal(expired.state,'expired');
      assert.equal(Number(expired.expired_block_height),101);
      assert.deepEqual(await expire(intentId,200,500),expired);
      assert.equal((await intentState(intentId)).status,'expired');
      assert.equal((await row('SELECT state FROM public.generation_escrow_recovery WHERE intent_id=$1',[intentId])).state,'released');
      assert.equal(await begin(intentId,id()),undefined);
      await rejects(() => store(intentId,token,signed,address('X').repeat(2)));
      await rejects(() => confirm(intentId,address('X').repeat(2)));
      assert.deepEqual(await prepare(args(intentId)),expired);
    }
    const {intentId} = await pending();
    await db.query("UPDATE public.generation_payment_intents SET deposit_confirmed_at=now() WHERE id=$1",[intentId]);
    await rejects(() => expire(intentId));
  });
  await check('failed recovery release rolls back deposit and intent expiry together', async () => {
    const {intentId} = await pending();
    await db.query("UPDATE public.generation_escrow_recovery SET state='confirmed',delivered_units=0,settlement_signature='fixture',confirmed_at=now() WHERE intent_id=$1",[intentId]);
    await rejects(() => expire(intentId));
    assert.equal((await state(intentId)).state,'prepared');
    assert.equal((await intentState(intentId)).status,'building');
  });
  await check('deposit rerun preserves prepared and funded audit records', async () => {
    const prepared = await pending(); const confirmed = await row("SELECT * FROM public.generation_escrow_deposits WHERE state='funded' LIMIT 1");
    const fs = await import('node:fs');
    await db.exec(fs.readFileSync(new URL('../migrations/2026-10-06-escrow-deposit-persistence.sql',import.meta.url),'utf8'));
    assert.deepEqual(await state(prepared.intentId),prepared.prepared);
    assert.deepEqual(await state(confirmed.intent_id),confirmed);
  });
  if (pgOptions) {
    for (const operation of ['prepare','submit']) await check(`parallel ${operation} waits and preserves a single winner`, async () => {
      const intentId = await intent(); await reserve(intentId);
      const first = args(intentId); const second = args(intentId,{height:200,blockhash:address('J')});
      if (operation === 'submit') await prepare(first);
      const holder = new pg.Client(pgOptions); const contender = new pg.Client(pgOptions);
      await holder.connect(); await contender.connect();
      let waitingQuery;
      try {
        await holder.query('BEGIN');
        await contender.query("SET statement_timeout='10s'");
        const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const contenderPid = (await contender.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const query = operation === 'prepare' ? prepareSql : beginSql;
        const winningArgs = operation === 'prepare' ? first : [intentId,'buyer-test',id(),100];
        const losingArgs = operation === 'prepare' ? second : [intentId,'buyer-test',id(),100];
        const won = (await holder.query(query,winningArgs)).rows[0];
        waitingQuery = contender.query(query,losingArgs).then(result => ({result}),error => ({error}));
        let blocked = false;
        for (let probe=0; probe<1000 && !blocked; probe++) {
          blocked = (await row('SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked',[holderPid,contenderPid])).blocked;
        }
        assert.equal(blocked,true,'The competing request must wait for the intent lock');
        await holder.query('COMMIT');
        const lost = await waitingQuery; assert.equal(lost.error,undefined);
        if (operation === 'prepare') assert.deepEqual(lost.result.rows,[won]);
        else assert.deepEqual(lost.result.rows,[]);
        assert.deepEqual(await state(intentId),won);
      } finally {
        await holder.query('ROLLBACK');
        if (waitingQuery) await waitingQuery;
        await holder.end(); await contender.end();
      }
    });
  }
}
