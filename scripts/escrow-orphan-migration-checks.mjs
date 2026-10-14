import assert from 'node:assert/strict';
import pg from 'pg';

/** Runs against the main runner's empty offline/loopback-only fixture database. */
export async function checkEscrowOrphans({db,row,check,rejects,intent,reserve,pgOptions}) {
  const sweep=async(limit=20)=>(await db.query('SELECT * FROM public.expire_orphaned_generation_escrow_reservations($1)',[limit])).rows.map(r=>r.intent_id);
  const expired=async(artist='artist-orphan-fixture',status='quoted')=>{
    const payment=await intent(artist,1_000_000,100_000,status);await reserve(payment,4);
    await db.query("UPDATE public.generation_payment_intents SET expires_at='2020-01-01' WHERE id=$1",[payment]);
    return payment;
  };
  const status=payment=>row('SELECT i.status,r.state,r.reserved_micro FROM public.generation_payment_intents i JOIN public.generation_escrow_recovery r ON r.intent_id=i.id WHERE i.id=$1',[payment]);
  const prepared=async(payment)=>{
    const message=Buffer.from([2,0,4,6,...Array(100).fill(7)]);
    const unsigned=Buffer.concat([Buffer.from([2]),Buffer.alloc(128),message]);
    await db.query(`SELECT * FROM public.prepare_generation_escrow_deposit(
      $1,'buyer-test',$2,'solana-devnet',$3,$4,$5,$6,$7,$8,$9,$10,100,1000,1900)`,
    [payment,'P'.repeat(32),'B'.repeat(32),'R'.repeat(32),'T'.repeat(32),
      'E'.repeat(32)+payment.replaceAll('-','').slice(-10).replaceAll('0','A'),
      'V'.repeat(32)+payment.replaceAll('-','').slice(-10).replaceAll('0','A'),unsigned,message,'H'.repeat(32)]);
  };
  await check('orphan cleanup is rerunnable and service-only with a fixed safe search path',async()=>{
    for(const role of ['anon','authenticated']){
      await db.exec(`SET ROLE ${role}`);await rejects(()=>sweep(),'42501');await db.exec('RESET ROLE');
    }
    const fn=await row("SELECT p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) AS body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='expire_orphaned_generation_escrow_reservations'");
    assert.equal(fn.prosecdef,true);assert.deepEqual(fn.proconfig,['search_path=pg_catalog']);
    assert.match(fn.body,/FOR UPDATE OF i SKIP LOCKED/i);
    const afterLock=fn.body.slice(fn.body.indexOf('LOOP'));
    assert.match(afterLock,/EXISTS\(SELECT 1 FROM public\.generation_escrow_deposits d WHERE d\.intent_id=v_id\)/);
    await db.exec('SET ROLE service_role');await sweep();await db.exec('RESET ROLE');
  });
  await check('expired never-persisted reservation releases held debt and keeps its audit row',async()=>{
    const artist='artist-orphan-debt';
    await db.query("INSERT INTO public.artist_cost_ledger(artist_wallet,mint,entry,micro,lamports) VALUES($1,$2,'fronted',150000,2039280)",
      [artist,'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU']);
    const payment=await expired(artist);assert.equal(Number((await status(payment)).reserved_micro),150_000);
    assert.ok((await sweep()).includes(payment));
    const released=await status(payment);assert.equal(released.status,'expired');assert.equal(released.state,'released');
    assert.equal(Number(released.reserved_micro),150_000);
    assert.ok(!(await sweep()).includes(payment));
    assert.equal(Number((await reserve(await intent(artist),4)).reserved_micro),150_000);
    assert.equal(Number((await row("SELECT count(*) AS n FROM public.artist_cost_ledger WHERE artist_wallet=$1 AND entry='recovered'",[artist])).n),0);
  });
  await check('fresh reservations remain active while expired building orphans are released',async()=>{
    const fresh=await intent('artist-orphan-fresh');await reserve(fresh,4);
    const building=await expired('artist-orphan-building','building');
    const ids=await sweep();assert.ok(!ids.includes(fresh));assert.ok(ids.includes(building));
    assert.equal((await status(fresh)).state,'reserved');assert.equal((await status(fresh)).status,'quoted');
  });
  await check('any persisted deposit remains reserved even after quote expiry',async()=>{
    const payment=await intent('artist-orphan-prepared');await reserve(payment,4);await prepared(payment);
    await db.query("UPDATE public.generation_payment_intents SET expires_at='2020-01-01' WHERE id=$1",[payment]);
    assert.ok(!(await sweep()).includes(payment));assert.equal((await status(payment)).state,'reserved');
    assert.equal((await row('SELECT state FROM public.generation_escrow_deposits WHERE intent_id=$1',[payment])).state,'prepared');
  });
  await check('legacy authorization and funding markers always exclude orphan cleanup',async()=>{
    for(const [column,value] of [
      ['nonce_account','legacy-nonce'],['nonce_authority','legacy-authority'],['authorized_at','2026-10-04'],
      ['authorized_tx_ct','legacy-ciphertext'],['captured_at','2026-10-04'],['voided_at','2026-10-04'],
      ['consumed_at','2026-10-04'],['fulfilled_at','2026-10-04'],['deposit_signature','deposit-receipt'],
      ['deposit_confirmed_at','2026-10-04'],['tx_signature','legacy-receipt'],
    ]){
      const payment=await expired('artist-orphan-marker-'+column);
      await db.query(`UPDATE public.generation_payment_intents SET ${column}=$2 WHERE id=$1`,[payment,value]);
      assert.ok(!(await sweep()).includes(payment),column);assert.equal((await status(payment)).state,'reserved',column);
    }
  });
  await check('orphan cleanup obeys bounded limits without deleting reservations',async()=>{
    const payments=await Promise.all([expired('artist-orphan-limit-a'),expired('artist-orphan-limit-b')]);
    const first=await sweep(1);assert.equal(first.length,1);assert.ok(payments.includes(first[0]));
    const second=await sweep(1);assert.equal(second.length,1);assert.ok(payments.includes(second[0]));assert.notEqual(first[0],second[0]);
    assert.equal(Number((await row('SELECT count(*) AS n FROM public.generation_escrow_recovery WHERE intent_id=ANY($1::uuid[])',[payments])).n),2);
  });
  if(pgOptions)await check('concurrent preparation holds the intent lock and cleanup skips it',async()=>{
    const payment=await expired('artist-orphan-lock');const holder=new pg.Client(pgOptions);await holder.connect();
    try{
      await holder.query('BEGIN');await holder.query('SELECT id FROM public.generation_payment_intents WHERE id=$1 FOR UPDATE',[payment]);
      assert.ok(!(await sweep()).includes(payment));
      await holder.query('COMMIT');assert.ok((await sweep()).includes(payment));
    }finally{await holder.query('ROLLBACK');await holder.end();}
  });
}
