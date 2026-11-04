import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registerUser } from '../src/modules/identity/registration.js';
import { submitOrder,evaluatePending } from '../src/modules/trading/service.js';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './harness.js';
import { migrate } from '../src/platform/migrate.js';
import { runWorkerLoop } from '../src/worker.js';
let h:TestHarness;
beforeAll(async()=>{h=await createHarness();await migrate(h.ownerPool);});
afterAll(async()=>{await h?.close();});
it('keeps a bounded sequential loop alive after refresh failure, records heartbeat, and drains on stop',async()=>{
  const events:string[]=[];let entered=0;let concurrent=0;let max=0;
  const task=async(name:string)=>{concurrent++;max=Math.max(max,concurrent);events.push(name);await new Promise(r=>setTimeout(r,3));concurrent--;};
  const worker=runWorkerLoop(h.appPool,{intervalMs:5,refresh:async()=>{entered++;throw Error('provider credentials must never log');},pending:()=>task('pending'),alerts:()=>task('alerts'),snapshots:()=>task('snapshots')});
  await new Promise(r=>setTimeout(r,65));await worker.stop();
  expect(max).toBe(1);expect(events.slice(0,3)).toEqual(['pending','alerts','snapshots']);expect(entered).toBe(1);
  const count=events.length;await new Promise(r=>setTimeout(r,20));expect(events).toHaveLength(count);
  const status=(await h.appPool.query('SELECT * FROM worker_status WHERE id=\'main\'')).rows[0];
  expect(status.heartbeat_at).toBeInstanceOf(Date);expect(status.pending_success_at).toBeInstanceOf(Date);expect(status.last_error).toBe('REFRESH_FAILED');
});
it('uses a dedicated advisory lock to prevent competing worker batches',async()=>{
  let active=0;let max=0;let calls=0;
  const blocked=async()=>{calls++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,20));active--;};
  const options={intervalMs:5,refresh:blocked,pending:async()=>{},alerts:async()=>{},snapshots:async()=>{}};
  const first=runWorkerLoop(h.appPool,options);const second=runWorkerLoop(h.appPool,options);
  await new Promise(r=>setTimeout(r,75));await Promise.all([first.stop(),second.stop()]);expect(calls).toBeGreaterThan(0);expect(max).toBe(1);
});

it('latches quote wakes during a batch and evaluates sequentially without repeating HTTP refresh or snapshots',async()=>{
  let refreshes=0,snapshots=0,pending=0,active=0,max=0;
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const starts:number[]=[];
  const worker=runWorkerLoop(h.appPool,{intervalMs:10000,refresh:async()=>{refreshes++;},
    pending:async()=>{active++;max=Math.max(max,active);starts.push(Date.now());pending++;if(pending===1)await gate;active--;},
    alerts:async()=>{},snapshots:async()=>{snapshots++;}});
  try{
    await expect.poll(()=>pending).toBe(1);worker.wake();worker.wake();release();
    await expect.poll(()=>pending,{timeout:2500}).toBe(2);
    expect(refreshes).toBe(1);expect(snapshots).toBe(1);expect(max).toBe(1);
    expect(starts[1]!-starts[0]!).toBeGreaterThanOrEqual(900);
  }finally{release();await worker.stop();}
});

it('does not ask browsers to reload owned data when a quote batch changes no resources',async()=>{
  const listener=await h.appPool.connect();const events:string[]=[];
  listener.on('notification',message=>{if(message.channel==='paper_market_activity')events.push(message.payload??'');});
  await listener.query('LISTEN paper_market_activity');let batches=0;
  const worker=runWorkerLoop(h.appPool,{intervalMs:10000,refresh:async()=>{},pending:async()=>{batches++;},alerts:async()=>{},snapshots:async()=>{}});
  try{await expect.poll(()=>batches).toBe(1);worker.wake();await expect.poll(()=>batches,{timeout:2500}).toBe(2);await worker.stop();expect(events).toEqual([]);}
  finally{await worker.stop();await listener.query('UNLISTEN paper_market_activity');listener.release();}
});

it('compiled worker resumes a durable stop-limit trigger, restarts without duplicate execution, and exits cleanly on SIGTERM',async()=>{
 const id=randomUUID().replaceAll('-','');const user=(await registerUser(h.appPool,{username:id.slice(0,20),email:`${id}@example.com`,password:'unused'},async()=>'unused')).user;
 const instrumentId=(await h.ownerPool.query(`INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,provider) VALUES($1,'Worker','NSE','INR',1,'EQUITY',true,'fixture') RETURNING id`,[id])).rows[0].id;
 await h.ownerPool.query(`INSERT INTO latest_quotes(instrument_id,price,observed_at,session,raw_currency,raw_price,action_key,provider) VALUES($1,100,clock_timestamp(),'REGULAR','INR',100,'fixture-v1','fixture')`,[instrumentId]);
 const order=(await submitOrder(h.appPool,user.id,{instrumentId,side:'BUY',type:'STOP_LIMIT',quantity:'1',stopPrice:'160',limitPrice:'155'},randomUUID())).order;
 await h.ownerPool.query(`UPDATE latest_quotes SET price=170,raw_price=170,observed_at=clock_timestamp() WHERE instrument_id=$1`,[instrumentId]);await evaluatePending(h.appPool);
 expect((await h.appPool.query('SELECT status FROM orders WHERE id=$1',[order.id])).rows[0].status).toBe('TRIGGERED');
 const url=new URL('postgresql://127.0.0.1');url.hostname=h.appPool.options.host!;url.port=String(h.appPool.options.port);url.username=h.appPool.options.user!;url.password=String(h.appPool.options.password);url.pathname=`/${h.appPool.options.database}`;
 async function waitUntil(check:()=>Promise<boolean>){const deadline=Date.now()+5000;while(!await check()){if(Date.now()>deadline)throw Error('Worker process did not make progress');await new Promise(r=>setTimeout(r,10));}}
 async function run(check:()=>Promise<boolean>){
  const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/src/worker.js',import.meta.url))],{env:{...process.env,NODE_ENV:'test',DATABASE_URL:url.href,PUBLIC_ORIGIN:'https://paper.example',CSRF_SECRET:'compiled worker test session secret at least32bytes',MARKET_PROVIDER:'fixture'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{output+=String(chunk);});
  const exit=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  try{await waitUntil(async()=>output.includes('worker_started')&&await check()).catch(()=>{throw Error(`Worker process did not make progress: ${output}`);});child.kill('SIGTERM');expect(await exit).toBe(0);expect(output).toContain('worker_stopped');}
  finally{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');}
 }
 await run(async()=>(await h.appPool.query('SELECT status FROM orders WHERE id=$1',[order.id])).rows[0].status==='FILLED');
 await run(async()=>true);
 expect((await h.appPool.query('SELECT count(*)::int n,max(price)::text price FROM executions WHERE order_id=$1',[order.id])).rows[0]).toEqual({n:1,price:'150.00000000'});
 expect((await h.appPool.query('SELECT cash_balance::text FROM accounts WHERE user_id=$1',[user.id])).rows[0].cash_balance).toBe('999850.00');
});
it('compiled production worker refuses fixture mode before starting a loop',async()=>{
 const url=new URL('postgresql://127.0.0.1');url.hostname=h.appPool.options.host!;url.port=String(h.appPool.options.port);url.username=h.appPool.options.user!;url.password=String(h.appPool.options.password);url.pathname=`/${h.appPool.options.database}`;
 const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/src/worker.js',import.meta.url))],{env:{...process.env,NODE_ENV:'production',DATABASE_URL:url.href,PUBLIC_ORIGIN:'https://paper.example',CSRF_SECRET:'compiled worker test session secret at least32bytes',MARKET_PROVIDER:'fixture'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('worker_started'))child.kill('SIGTERM');});child.stderr.on('data',chunk=>{output+=String(chunk);});
 const timeout=setTimeout(()=>child.kill('SIGKILL'),3000);
 try{const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});expect(code).toBe(1);expect(output).toContain('Worker startup failed');expect(output).not.toContain('worker_started');}
 finally{clearTimeout(timeout);if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');}
});
