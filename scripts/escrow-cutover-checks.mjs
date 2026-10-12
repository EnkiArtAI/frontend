import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db=new PGlite();
// These are the columns read by the guard, not a replacement for all production constraints.
await db.exec(`CREATE TABLE public.generation_payment_intents (
 id integer PRIMARY KEY,deposit_confirmed_at timestamptz,nonce_account text,authorized_at timestamptz,
 voided_at timestamptz,captured_at timestamptz,tx_signature text,fulfilled_at timestamptz,status text,total_micro bigint
)`);
const sql=await readFile(new URL('../migrations/2026-10-12-escrow-cutover-guard.sql',import.meta.url),'utf8');
let count=0;
const run=async(fields,blocked)=>{
  await db.exec('TRUNCATE public.generation_payment_intents');
  if(fields){const keys=Object.keys(fields);await db.query(`INSERT INTO public.generation_payment_intents(id,${keys.join(',')}) VALUES(1,${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(fields));}
  if(blocked) {await assert.rejects(db.exec(sql),error=>error.code==='55000');await db.exec('ROLLBACK');}
  else await db.exec(sql);
  count++;
};
const now='2026-10-12T00:00:00Z';
await run(null,false);
await run({nonce_account:'legacy-nonce',status:'building',total_micro:1},true);
await run({authorized_at:now,status:'generating',total_micro:1},true);
await run({captured_at:now,status:'generating',total_micro:1},true);
await run({captured_at:now,tx_signature:'landed',status:'confirmed',total_micro:1},true);
await run({status:'confirmed',total_micro:1},true);
await run({nonce_account:'legacy-nonce',voided_at:now,status:'voided',total_micro:1},false);
await run({captured_at:now,tx_signature:'landed',fulfilled_at:now,status:'confirmed',total_micro:1},false);
await run({deposit_confirmed_at:now,status:'confirmed',total_micro:1},false);
await run({status:'quoted',total_micro:1},false);
await run({status:'confirmed',total_micro:0},false);
await db.close();process.stdout.write(`PASS ${count} escrow-cutover guard checks (offline PostgreSQL)\n`);
