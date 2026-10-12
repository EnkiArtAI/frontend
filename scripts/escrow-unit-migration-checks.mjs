import assert from 'node:assert/strict';
import pg from 'pg';

export async function checkEscrowUnits({ db,row,check,rejects,id,intent,reserve,pgOptions }) {
  const now = Date.parse('2026-10-05T00:00:00Z')/1000;
  const userId=id(), otherUserId=id();
  await db.query('INSERT INTO public.users(id) VALUES($1),($2)',[userId,otherUserId]);
  await db.query("INSERT INTO public.user_wallets(user_id,address) VALUES($1,'buyer-test')",[userId]);
  const message=Buffer.from([2,0,4,6,...Array(200).fill(7)]);
  const unsigned=Buffer.concat([Buffer.from([2]),Buffer.alloc(128),message]);
  const signed=Buffer.concat([Buffer.from([2]),Buffer.alloc(64,8),Buffer.alloc(64,9),message]);
  let nextAddress=0;
  async function funded(units=4) {
    const intentId=await intent('artist-unit',1_000_000,100_000);
    await reserve(intentId,units);
    const suffix=String(++nextAddress).replaceAll('0','A');
    await row('SELECT * FROM public.prepare_generation_escrow_deposit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [intentId,'buyer-test','P'.repeat(32),'solana-devnet','B'.repeat(32),'R'.repeat(32),'T'.repeat(32),
      'U'.repeat(32)+suffix,'W'.repeat(32)+suffix,unsigned,message,'H'.repeat(32),100,now,now+1800]);
    const token=id(), signature='S'.repeat(64)+suffix;
    await row('SELECT * FROM public.begin_generation_escrow_submit($1,$2,$3,$4)',[intentId,'buyer-test',token,100]);
    await row('SELECT * FROM public.store_generation_escrow_signed_deposit($1,$2,$3,$4,$5)',[intentId,'buyer-test',token,signed,signature]);
    await row('SELECT * FROM public.confirm_generation_escrow_deposit($1,$2,$3,$4)',[intentId,'buyer-test',signature,123]);
    return intentId;
  }
  const claimSql='SELECT * FROM public.claim_generation_escrow_unit($1,$2,$3,$4,$5,$6,$7)';
  const claim=(intentId,index=0,token=id(),changes={}) => row(claimSql,[intentId,changes.owner??'buyer-test',
    changes.user??userId,index,token,changes.time??now,changes.slot??123]);
  const deliver=(intentId,index,token,generation) => row('SELECT * FROM public.deliver_generation_escrow_unit($1,$2,$3,$4,$5)',
    [intentId,'buyer-test',index,token,generation]);
  const fail=(intentId,index,token) => row('SELECT * FROM public.fail_generation_escrow_unit($1,$2,$3,$4)',[intentId,'buyer-test',index,token]);
  const close=(intentId,cancel=false,time=now) => row('SELECT * FROM public.close_generation_escrow_batch($1,$2,$3,$4)',[intentId,'buyer-test',time,cancel]);
  const image=async (user=userId,accepted=true) => {
    const generation=id();
    await db.query('INSERT INTO public.generations(id,user_id) VALUES($1,$2)',[generation,user]);
    await db.query('INSERT INTO public.generated_images(generation_id,user_id,accepted,storage_url) VALUES($1,$2,$3,$4)',[generation,user,accepted,'https://image.fixture.test/durable.png']);
    return generation;
  };

  await check('unit schema reruns and prevents direct client or service writes',async()=>{
    for(const role of ['anon','authenticated','service_role']) {
      await db.exec(`SET ROLE ${role}`);
      await rejects(()=>db.query('INSERT INTO public.generation_escrow_batches(intent_id) VALUES($1)',[id()]),'42501');
      if(role!=='service_role') await rejects(()=>claim(id()),'42501');
      await db.exec('RESET ROLE');
    }
  });
  await check('one funded unit grants exactly one provider invocation, including token replay',async()=>{
    const payment=await funded(),token=id();
    assert.equal((await claim(payment,0,token)).state,'running');
    assert.equal(await claim(payment,0,token),undefined);
    assert.equal(await claim(payment,0),undefined);
    assert.equal(Number((await row('SELECT count(*) n FROM public.generation_escrow_units WHERE intent_id=$1',[payment])).n),4);
  });
  await check('unit admission requires owned funded payment, registered user, valid index and fresh chain bank',async()=>{
    const payment=await funded();
    await rejects(()=>claim(payment,0,id(),{owner:'stranger'}));
    assert.equal(await claim(payment,0,id(),{user:otherUserId}),undefined);
    assert.equal(await claim(payment,-1),undefined);
    assert.equal(await claim(payment,4),undefined);
    assert.equal(await claim(payment,0,id(),{slot:122}),undefined);
    assert.equal(await claim(payment,0,id(),{time:now-1}),undefined);
    assert.equal(await claim(payment,0,id(),{time:now+1380}),undefined);
    const unfunded=await intent(); await rejects(()=>claim(unfunded));
  });
  await check('delivery needs its own token and an accepted durable image belonging to the claimed user',async()=>{
    const payment=await funded(),token=id(); await claim(payment,0,token);
    const generation=await image();
    await rejects(async()=>deliver(payment,0,id(),generation));
    await rejects(async()=>deliver(payment,0,token,await image(otherUserId)));
    await rejects(async()=>deliver(payment,0,token,await image(userId,false)));
    const naked=id();await db.query('INSERT INTO public.generations(id,user_id) VALUES($1,$2)',[naked,userId]);
    await rejects(async()=>deliver(payment,0,token,naked));
    assert.equal((await deliver(payment,0,token,generation)).state,'delivered');
    assert.equal((await deliver(payment,0,token,generation)).generation_id,generation);
    await rejects(async()=>deliver(payment,0,token,await image()));
  });
  await check('a durable generation cannot be charged to two units',async()=>{
    const payment=await funded(),a=id(),b=id(); await claim(payment,0,a);await claim(payment,1,b);
    const generation=await image();await deliver(payment,0,a,generation);
    await rejects(async()=>deliver(payment,1,b,generation),'23505');
  });
  await check('failure cannot erase a delivered unit and never opens a retry claim',async()=>{
    const payment=await funded(1),token=id();await claim(payment,0,token);
    await fail(payment,0,id());
    assert.equal((await row('SELECT state FROM public.generation_escrow_units WHERE intent_id=$1',[payment])).state,'running');
    await fail(payment,0,token);assert.equal(await claim(payment,0),undefined);
    assert.equal((await close(payment)).delivered_units,0);
  });
  await check('batch waits for running work and freezes k from delivered rows only',async()=>{
    const payment=await funded(2),a=id(),b=id();await claim(payment,0,a);await claim(payment,1,b);
    await deliver(payment,0,a,await image());
    assert.equal((await close(payment)).state,'open');
    await fail(payment,1,b);
    const ready=await close(payment);assert.equal(ready.state,'ready');assert.equal(ready.delivered_units,1);
    assert.equal((await close(payment,true)).delivered_units,1);
    await db.query('UPDATE public.generated_images SET deleted_at=now() WHERE generation_id IN (SELECT generation_id FROM public.generation_escrow_units WHERE intent_id=$1)',[payment]);
    assert.equal((await close(payment)).delivered_units,1,'Deleting gallery images cannot change the frozen delivered count');
  });
  await check('cancellation closes admission but lets already running work finish its lease',async()=>{
    const payment=await funded(2),token=id();await claim(payment,0,token);
    assert.equal((await close(payment,true)).state,'closing');
    assert.equal(await claim(payment,1),undefined);
    await deliver(payment,0,token,await image());
    assert.equal((await close(payment)).delivered_units,1);
  });
  await check('stale running leases close without a second provider invocation or late delivery',async()=>{
    const payment=await funded(1),token=id();await claim(payment,0,token);
    await db.query("UPDATE public.generation_escrow_units SET lease_expires_at=now()-interval '1 second' WHERE intent_id=$1",[payment]);
    await rejects(async()=>deliver(payment,0,token,await image()));
    assert.equal((await close(payment)).delivered_units,0);assert.equal(await claim(payment),undefined);
  });
  await check('unused paid units stop admission early enough to settle before chain expiry',async()=>{
    const payment=await funded(4);
    assert.equal((await close(payment,false,now+1380)).delivered_units,0);
    assert.equal(await claim(payment),undefined);
  });
  if(pgOptions) await check('parallel unit claims wait on the intent and only one acquires the unit',async()=>{
    const payment=await funded(1),a=id(),b=id();
    const first=new pg.Client(pgOptions),second=new pg.Client(pgOptions);
    await first.connect();await second.connect();
    let pending;
    try {
      await first.query('BEGIN');await second.query('BEGIN');await second.query("SET LOCAL statement_timeout='10s'");
      const parameters=token=>[payment,'buyer-test',userId,0,token,now,123];
      assert.equal((await first.query(claimSql,parameters(a))).rows.length,1);
      const pid=(await second.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending=second.query(claimSql,parameters(b)).then(result=>({result}),error=>({error}));
      let waiting=false;
      for(let probe=0;probe<1000&&!waiting;probe++) waiting=(await row("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).waiting;
      assert.equal(waiting,true);await first.query('COMMIT');
      const answer=await pending;if(answer.error) throw answer.error;
      assert.equal(answer.result.rows.length,0);await second.query('COMMIT');
    } finally { await first.query('ROLLBACK');await second.query('ROLLBACK');if(pending)await pending;await first.end();await second.end(); }
  });
}

