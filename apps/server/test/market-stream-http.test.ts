import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { marketRoutes } from '../src/modules/market-data/http.js';
import { closeMarketStreams } from '../src/modules/market-data/stream-http.js';
import { discoverInstruments, refreshInstrument } from '../src/modules/market-data/service.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { loadConfig } from '../src/platform/config.js';
import { errorHandler } from '../src/platform/http.js';
import { createSafeLogger } from '../src/platform/logging.js';
import { migrate } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';
let db: TestHarness; let app: express.Express; let cookie: string; let id: string; let server: Server; let base: string;
const controllers: AbortController[]=[];
beforeEach(async()=>{
  vi.stubEnv('MARKET_PROVIDER','fixture'); vi.stubEnv('NODE_ENV','test');
  db=await createHarness(); await migrate(db.ownerPool);
  const {user}=await registerUser(db.appPool,{username:'stream_user',email:'stream@example.com',password:'irrelevant'},async()=> 'hash');
  const token=randomBytes(32).toString('base64url');
  await db.appPool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",[user.id,createHash('sha256').update(token).digest('hex')]);
  cookie=`paper_session=${token}`;
  id=(await discoverInstruments(db.appPool,'AAPL'))[0]!.id; await refreshInstrument(db.appPool,id);
  const logger=createSafeLogger(()=>{});
  const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://app:secret@localhost/test',PUBLIC_ORIGIN:'http://localhost',CSRF_SECRET:'a'.repeat(32)});
  app=express(); app.use(cookieParser()); app.use('/api',marketRoutes({pool:db.appPool,config,logger})); app.use(errorHandler(logger));
  server=app.listen(0); await new Promise<void>(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterEach(async()=>{for(const controller of controllers.splice(0))controller.abort(); await closeMarketStreams(db.appPool); await new Promise<void>(resolve=>server.close(()=>resolve())); await db.close(); vi.unstubAllEnvs();});
async function open(ids=id){const controller=new AbortController(); controllers.push(controller); return fetch(`${base}/api/market/stream?ids=${ids}`,{headers:{Cookie:cookie},signal:controller.signal});}
async function frame(reader:ReadableStreamDefaultReader<Uint8Array>,event:string){let text='';for(let n=0;n<20;n++){const chunk=await reader.read();if(chunk.done)return text;text+=new TextDecoder().decode(chunk.value);if(text.includes(`event: ${event}\n`))return text;}throw new Error('Expected event');}
it('requires auth and validates origin, query shape, provider and bounded identifiers',async()=>{
  expect((await request(app).get('/api/market/stream')).status).toBe(401);
  for(const query of ['ids=bad','extra=1','ids=a&ids=b',`ids=${randomUUID()}`,`ids=${Array.from({length:101},()=>randomUUID()).join(',')}`])expect((await request(app).get(`/api/market/stream?${query}`).set('Cookie',cookie)).status).toBe(400);
  expect((await request(app).get(`/api/market/stream?ids=${id}`).set('Cookie',cookie).set('Origin','http://foreign.example')).status).toBe(403);
  await db.ownerPool.query("UPDATE instruments SET provider='yahoo' WHERE id=$1",[id]);
  expect((await request(app).get(`/api/market/stream?ids=${id}`).set('Cookie',cookie)).status).toBe(400);
});
it('fans out committed quote DTOs and opaque activity events using one listener',async()=>{
  const first=await open(`${id},${id}`);const second=await open('');
  expect(first.headers.get('content-type')).toContain('text/event-stream');
  const quotes=first.body!.getReader();const activity=second.body!.getReader();
  const initial=await frame(quotes,'quote');expect(initial).toContain('150.00000000');expect(initial).toContain('AAPL');
  await db.appPool.query("SELECT pg_notify('paper_market_quotes',$1)",[JSON.stringify({instrumentId:id,transport:'stream'})]);
  const update=await frame(quotes,'quote');expect(update).not.toMatch(/accountId|userId|sessionId|stream@example/);
  await db.appPool.query("SELECT pg_notify('paper_market_activity',$1)",[JSON.stringify({accountId:'private',orderId:'secret'})]);
  expect(await frame(activity,'activity')).toContain('event: activity\ndata: {}');
  const listeners=await db.appPool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND query='LISTEN paper_market_activity'");
  expect(listeners.rows[0].n).toBe(1);
});
it('bounds each user to two connections and releases listeners on shutdown',async()=>{
  await open();await open();expect((await open()).status).toBe(429);
  await closeMarketStreams(db.appPool);
  expect(db.appPool.waitingCount).toBe(0);
});
it('closes a revoked session at the next heartbeat',async()=>{
  const response=await open('');const reader=response.body!.getReader();await reader.read();
  await db.appPool.query('UPDATE sessions SET revoked_at=now()');
  const end=await reader.read();expect(end.done).toBe(true);
},15000);
