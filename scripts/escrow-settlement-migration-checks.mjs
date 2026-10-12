import assert from 'node:assert/strict';

export async function checkEscrowTransactions({db,row,check,rejects,id,units}) {
  const {funded,claim,deliver,fail,close,image,now}=units;
  const wire=Buffer.from([1,...Array(64).fill(8),1,0,3,...Array(150).fill(7)]);
  let signatureIndex=0;
  const sig=()=> 'S'.repeat(64)+String(++signatureIndex).replaceAll('0','A');
  const storeSql='SELECT * FROM public.store_generation_escrow_transaction($1,$2,$3,$4,$5,$6,$7,$8)';
  const store=(payment,kind='settle',changes={})=>row(storeSql,[payment,changes.owner??'buyer-test',kind,
    changes.wire??wire,changes.signature??sig(),'H'.repeat(32),changes.height??100,changes.time??now]);
  const confirm=(payment,tx,changes={})=>row('SELECT * FROM public.confirm_generation_escrow_transaction($1,$2,$3,$4,$5)',
    [payment,changes.owner??'buyer-test',tx.id,changes.signature??tx.signature,changes.slot??200]);
  const expire=(payment,tx,height=101)=>row('SELECT * FROM public.expire_generation_escrow_transaction($1,$2,$3,$4,$5)',
    [payment,'buyer-test',tx.id,height,201]);
  const ready=async(delivered=false)=>{
    const payment=await funded(1),token=id();await claim(payment,0,token);
    if(delivered)await deliver(payment,0,token,await image());else await fail(payment,0,token);
    await close(payment);return payment;
  };
  await check('settlement migration is idempotent and denies client RPCs/direct service writes',async()=>{
    for(const role of ['anon','authenticated','service_role']) {
      await db.exec(`SET ROLE ${role}`);
      await rejects(()=>db.query('DELETE FROM public.generation_escrow_transactions'),'42501');
      if(role!=='service_role')await rejects(()=>store(id()),'42501');
      await db.exec('RESET ROLE');
    }
  });
  await check('settlement wire requires a frozen ready batch, ownership and canonical signed legacy boundaries',async()=>{
    const open=await funded(1);await rejects(()=>store(open));
    const payment=await ready();await rejects(()=>store(payment,'settle',{owner:'stranger'}));
    await rejects(()=>store(payment,'reclaim'));await rejects(()=>store(payment,'unexpected'));
    await rejects(()=>store(payment,'settle',{wire:Buffer.alloc(200)}),'23514');
    assert.equal((await store(payment)).state,'submitted');
  });
  await check('racing server builders and retries receive the first stored signed transaction',async()=>{
    const payment=await ready(),first=await store(payment);
    const second=await store(payment,'settle',{wire:Buffer.from([1,...Array(64).fill(9),1,0,3,...Array(150).fill(6)])});
    assert.equal(second.id,first.id);assert.equal(second.signature,first.signature);
    assert.deepEqual(Buffer.from(second.signed_transaction),wire);
  });
  await check('settlement confirmation binds the stored receipt and books only database-delivered units once',async()=>{
    const payment=await ready(true),tx=await store(payment);
    await rejects(()=>confirm(payment,tx,{signature:sig()}));await rejects(()=>confirm(payment,tx,{slot:0}));
    const settled=await confirm(payment,tx);assert.equal(settled.state,'settled');assert.equal(settled.delivered_units,1);
    assert.equal((await confirm(payment,tx)).settlement_signature,tx.signature);
    const recovery=await row('SELECT * FROM public.generation_escrow_recovery WHERE intent_id=$1',[payment]);
    assert.equal(recovery.delivered_units,1);assert.equal(recovery.settlement_signature,tx.signature);
  });
  await check('reclaim is a separate persisted attempt and preserves already booked settlement',async()=>{
    const payment=await ready(true),settle=await store(payment);await confirm(payment,settle);
    const reclaim=await store(payment,'reclaim');assert.notEqual(reclaim.id,settle.id);
    assert.equal((await confirm(payment,reclaim)).state,'closed');
    const recovery=await row('SELECT * FROM public.generation_escrow_recovery WHERE intent_id=$1',[payment]);
    assert.equal(recovery.settlement_signature,settle.signature);assert.equal(recovery.delivered_units,1);
    assert.equal((await close(payment)).state,'closed');
  });
  await check('rebuilding an attempt requires blockheight expiry and retains its audit wire',async()=>{
    const payment=await ready(),tx=await store(payment);
    await rejects(()=>expire(payment,tx,100));
    assert.equal((await expire(payment,tx)).state,'expired');
    const retry=await store(payment);assert.notEqual(retry.id,tx.id);
    await rejects(()=>confirm(payment,tx));
    await confirm(payment,retry);await rejects(()=>expire(payment,retry));
    assert.equal(Number((await row('SELECT count(*) n FROM public.generation_escrow_transactions WHERE intent_id=$1',[payment])).n),2);
  });
  await check('worker candidates include abandoned funded orders and exclude closed history',async()=>{
    const abandoned=await funded(1),finished=await ready(true);
    const settle=await store(finished);await confirm(finished,settle);
    const reclaim=await store(finished,'reclaim');await confirm(finished,reclaim);
    const candidates=(await db.query('SELECT * FROM public.generation_escrow_work_items(50)')).rows;
    assert(candidates.some(item=>item.intent_id===abandoned));assert(!candidates.some(item=>item.intent_id===finished));
    for(const role of ['anon','authenticated']) {
      await db.exec('SET ROLE '+role);await rejects(()=>db.query('SELECT * FROM public.generation_escrow_work_items(50)'),'42501');await db.exec('RESET ROLE');
    }
  });
  await check('a failed recovery confirmation rolls back transaction and batch confirmation',async()=>{
    const payment=await ready(true),tx=await store(payment);
    await db.query("UPDATE public.generation_escrow_recovery SET state='released',released_at=now() WHERE intent_id=$1",[payment]);
    await rejects(()=>confirm(payment,tx));
    assert.equal((await row('SELECT state FROM public.generation_escrow_transactions WHERE id=$1',[tx.id])).state,'submitted');
    assert.equal((await row('SELECT state FROM public.generation_escrow_batches WHERE intent_id=$1',[payment])).state,'ready');
  });
}
