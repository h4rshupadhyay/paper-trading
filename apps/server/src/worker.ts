import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { refreshActive, getProvider } from './modules/market-data/service.js';
import { evaluatePending } from './modules/trading/service.js';
import { evaluateAlerts } from './modules/user-tools/service.js';
import { sampleSnapshots } from './modules/portfolio/service.js';
import { createPool } from './platform/db.js';
import { loadConfig } from './platform/config.js';
import { readSchemaVersion } from './platform/migrate.js';
import { createSafeLogger, type SafeLogger } from './platform/logging.js';
import { startMarketStream } from './modules/market-data/stream-worker.js';
type WorkerOptions={intervalMs?:number;refresh?:()=>Promise<void>;pending?:()=>Promise<void>;alerts?:()=>Promise<void>;snapshots?:()=>Promise<void>;logger?:SafeLogger};
export function runWorkerLoop(pool:Pool,options:WorkerOptions={}):{stop():Promise<void>;wake():void;done:Promise<void>}{
  const interval=options.intervalMs??15000;
  if(!Number.isInteger(interval)||interval<1||interval>60000)throw Error('Invalid worker interval');
  let stopped=false;let wake:(()=>void)|undefined;
  let refreshFailures=0;let nextRefresh=0;
  let dirty=false;let nextRegular=0;let nextQuoteBatch=0;
  const logger=options.logger??createSafeLogger();
  const tasks=[['refresh',options.refresh??(()=>refreshActive(pool))],['pending',options.pending??(()=>evaluatePending(pool))],
    ['alerts',options.alerts??(()=>evaluateAlerts(pool))],['snapshots',options.snapshots??(()=>sampleSnapshots(pool))]] as const;
  async function tick(quoteOnly=false):Promise<boolean>{
    // This session owns the lock across the whole bounded batch. Market refresh takes its
    // own independent provider lock; all financial operations still own their account locks.
    const client=await pool.connect();let locked=false;let discard=false;
    try{
      locked=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(1480963205) AS locked')).rows[0]!.locked;
      if(!locked)return false;
      if(stopped)return true;
      await client.query(`INSERT INTO worker_status(id,heartbeat_at) VALUES('main',clock_timestamp()) ON CONFLICT(id) DO UPDATE SET heartbeat_at=clock_timestamp()`);
      let lastError:string|null=refreshFailures?'REFRESH_FAILED':null;
      for(const [name,task]of tasks){
        if(stopped)break;
        if(quoteOnly&&(name==='refresh'||name==='snapshots'))continue;
        if(name==='refresh'&&Date.now()<nextRefresh){lastError='REFRESH_FAILED';continue;}
        try{
          await task();
          // Names are an internal fixed tuple, never request input.
          await client.query(`UPDATE worker_status SET ${name}_success_at=clock_timestamp(),heartbeat_at=clock_timestamp() WHERE id='main'`);
          if(name==='refresh'){refreshFailures=0;nextRefresh=0;}
        }catch{
          lastError=`${name.toUpperCase()}_FAILED`;
          logger.error('worker_task_failed',{code:lastError});
          if(name==='refresh'){refreshFailures=Math.min(refreshFailures+1,6);nextRefresh=Date.now()+Math.min(60000,1000*2**refreshFailures);}
        }
      }
      await client.query(`UPDATE worker_status SET heartbeat_at=clock_timestamp(),last_error=$1 WHERE id='main'`,[lastError]);
      return true;
    }finally{
      if(locked)try{await client.query('SELECT pg_advisory_unlock(1480963205)');}catch{discard=true;}
      client.release(discard);
    }
  }
  async function loop():Promise<void>{
    while(!stopped){
      const now=Date.now();
      if(now>=nextRegular||(dirty&&now>=nextQuoteBatch)){
        const quoteOnly=now<nextRegular;dirty=false;nextQuoteBatch=now+1000;
        try{if(!await tick(quoteOnly))dirty=true;}catch{logger.error('worker_batch_failed',{code:'SERVICE_UNAVAILABLE'});}
        if(!quoteOnly)nextRegular=Date.now()+interval;
      }
      const delay=Math.max(1,Math.min(nextRegular,dirty?nextQuoteBatch:Infinity)-Date.now());
      if(!stopped)await new Promise<void>(resolve=>{const timer=setTimeout(()=>{wake=undefined;resolve();},delay);wake=()=>{clearTimeout(timer);wake=undefined;resolve();};});
    }
  }
  const done=loop();
  return {done,wake(){if(!stopped){dirty=true;wake?.();}},async stop(){stopped=true;wake?.();await done;}};
}
export async function startWorker():Promise<void>{
  const config=loadConfig(process.env);getProvider();const logger=createSafeLogger();const pool=createPool(config.databaseUrl);
  pool.on('error',()=>logger.error('database_unavailable',{code:'SERVICE_UNAVAILABLE'}));
  try{if(await readSchemaVersion(pool)!==config.expectedSchemaVersion)throw Error('Database schema version mismatch');}
  catch(error){await pool.end();throw error;}
  const worker=runWorkerLoop(pool,{logger});
  const stream=getProvider().name==='yfinance'?startMarketStream(pool,{logger,onQuote:()=>worker.wake()}):undefined;
  let stopping=false;
  async function shutdown(signal:string):Promise<void>{
    if(stopping)return;stopping=true;logger.info('worker_stopping',{signal});
    const deadline=setTimeout(()=>{logger.error('worker_shutdown_timeout',{});process.exit(1);},10000);
    try{await Promise.all([stream?.stop(),worker.stop()]);await pool.end();logger.info('worker_stopped',{});}
    finally{clearTimeout(deadline);process.off('SIGTERM',terminate);process.off('SIGINT',interrupt);}
  }
  function stop(signal:string):void{void shutdown(signal).catch(()=>{logger.error('worker_shutdown_failed',{});process.exitCode=1;});}
  function terminate():void{stop('SIGTERM');}function interrupt():void{stop('SIGINT');}
  process.on('SIGTERM',terminate);process.on('SIGINT',interrupt);logger.info('worker_started',{});
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  try{await startWorker();}catch{console.error('Worker startup failed');process.exitCode=1;}
}
