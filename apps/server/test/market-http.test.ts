import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { marketRoutes } from '../src/modules/market-data/http.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { loadConfig } from '../src/platform/config.js';
import { errorHandler, requestContext } from '../src/platform/http.js';
import { createSafeLogger } from '../src/platform/logging.js';
import { migrate } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';
let db: TestHarness; let app: express.Express; let cookie: string;
beforeEach(async () => {
  vi.stubEnv('MARKET_PROVIDER','fixture'); vi.stubEnv('NODE_ENV','test');
  db=await createHarness(); await migrate(db.ownerPool);
  const { user }=await registerUser(db.appPool,{username:'market_user',email:'market@example.com',password:'irrelevant'},async()=> 'hash');
  const token=randomBytes(32).toString('base64url');
  await db.appPool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",[user.id,createHash('sha256').update(token).digest('hex')]);
  cookie=`paper_session=${token}`;
  const logger=createSafeLogger(()=>{});
  const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://app:secret@localhost/test',PUBLIC_ORIGIN:'http://localhost',CSRF_SECRET:'a'.repeat(32)});
  app=express(); app.use(requestContext(logger),cookieParser()); app.use('/api',marketRoutes({pool:db.appPool,config,logger})); app.use(errorHandler(logger));
});
afterEach(async()=>{vi.unstubAllEnvs(); await db.close();});
it('requires a session and exposes canonical instrument/detail/quote DTOs',async()=>{
  expect((await request(app).get('/api/instruments')).status).toBe(401);
  const found=await request(app).get('/api/instruments?q=AAPL').set('Cookie',cookie);
  expect(found.status).toBe(200); expect(found.body.items).toHaveLength(1);
  const instrument=found.body.items[0]; expect(instrument).toMatchObject({symbol:'AAPL',currency:'USD',multiplier:'1.00000000',tradable:true});
  const detail=await request(app).get(`/api/instruments/${instrument.id}`).set('Cookie',cookie);
  expect(detail.body).toEqual({instrument});
  const quote=await request(app).get(`/api/instruments/${instrument.id}/quote`).set('Cookie',cookie);
  expect(quote.status).toBe(200); expect(quote.body.quote).toMatchObject({instrumentId:instrument.id,currency:'USD',price:'150.00000000',quality:'fresh',session:'REGULAR'});
  expect((await request(app).get('/api/instruments/not-an-id/quote').set('Cookie',cookie)).status).toBe(400);
});
it('refreshes all supported FX currencies before any instrument is requested',async()=>{
  const result=await request(app).get('/api/fx-rates').set('Cookie',cookie);
  expect(result.status).toBe(200); expect(result.body.baseCurrency).toBe('INR');
  expect(result.body.items).toHaveLength(6);
  expect(result.body.items.find((i:{currency:string})=>i.currency==='GBP')).toMatchObject({rate:'105.000000000000',quality:'fresh',provider:'fixture'});
});
it('accepts selected chart periods and intervals and rejects unsupported or repeated arguments',async()=>{
  const found=await request(app).get('/api/instruments?q=AAPL').set('Cookie',cookie); const id=found.body.items[0].id;
  for(const period of ['1d','5d','1mo','3mo','6mo','1y','5y']) {
    const result=await request(app).get(`/api/instruments/${id}/history?period=${period}&interval=1d`).set('Cookie',cookie);
    expect(result.status).toBe(200); expect(result.body.items.length).toBeGreaterThan(0); expect(result.body.currency).toBe('USD');
  }
  for(const query of ['period=max','interval=1s','period=1d&period=5d','foo=bar']) expect((await request(app).get(`/api/instruments/${id}/history?${query}`).set('Cookie',cookie)).status).toBe(400);
  expect((await request(app).get('/api/instruments?q=a&q=b').set('Cookie',cookie)).status).toBe(400);
});
it('does not intercept unrelated API routes with market authentication',async()=>{
  expect((await request(app).get('/api/unrelated-resource')).status).toBe(404);
});

it('authenticates snapshot reads and keeps missing optional statistics separate from usable quotes',async()=>{
  const found=await request(app).get('/api/instruments?q=AAPL').set('Cookie',cookie);const id=found.body.items[0].id;
  expect((await request(app).get(`/api/instruments/${id}/snapshot`)).status).toBe(401);
  const result=await request(app).get(`/api/instruments/${id}/snapshot`).set('Cookie',cookie);
  expect(result.status).toBe(200);expect(result.body.quote.price).toBe('150.00000000');expect(result.body.statistics).toBeNull();
  expect((await request(app).get(`/api/instruments/${id}/snapshot?extra=1`).set('Cookie',cookie)).status).toBe(400);
});
