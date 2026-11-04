import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { portfolioRoutes } from '../src/modules/portfolio/http.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { loadConfig } from '../src/platform/config.js';
import { errorHandler, requestContext } from '../src/platform/http.js';
import { createSafeLogger } from '../src/platform/logging.js';
import { migrate } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';
let db: TestHarness; let app: express.Express; let cookie: string; let userId:string;
beforeEach(async () => {
  vi.stubEnv('MARKET_PROVIDER','fixture'); vi.stubEnv('NODE_ENV','test');
  db=await createHarness(); await migrate(db.ownerPool);
  const { user }=await registerUser(db.appPool,{username:'market_user',email:'market@example.com',password:'irrelevant'},async()=> 'hash');
  userId=user.id;
  const token=randomBytes(32).toString('base64url');
  await db.appPool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",[user.id,createHash('sha256').update(token).digest('hex')]);
  cookie=`paper_session=${token}`;
  const logger=createSafeLogger(()=>{});
  const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://app:secret@localhost/test',PUBLIC_ORIGIN:'http://localhost',CSRF_SECRET:'a'.repeat(32)});
  app=express(); app.use(requestContext(logger),cookieParser()); app.use('/api',portfolioRoutes({pool:db.appPool,config,logger})); app.use(errorHandler(logger));
});
afterEach(async()=>{vi.unstubAllEnvs(); await db.close();});
async function samples(times:string[], owner=userId){
 await db.ownerPool.query(`INSERT INTO portfolio_snapshots(account_id,account_sequence,sample_bucket,sampled_at,cash_balance,holdings_value,total_value,unrealized_pl,quality)
 SELECT a.id,1,t,t,100,0,100+n,0,'fresh' FROM accounts a CROSS JOIN unnest($2::timestamptz[]) WITH ORDINALITY AS x(t,n) WHERE a.user_id=$1`,[owner,times]);
}
const get=(query='period=5y')=>request(app).get('/api/portfolio/history?'+query).set('Cookie',cookie);
it('authenticates, validates periods and isolates the owner',async()=>{
 expect((await request(app).get('/api/portfolio/history')).status).toBe(401);
 for(const query of ['period=max','period=1d&period=5d','period=5y&days=1'])expect((await get(query)).status).toBe(400);
 const other=await registerUser(db.appPool,{username:'other',email:'other@test.example',password:'unused'},async()=>'hash');
 await samples([new Date().toISOString()],other.user.id);
 expect((await get()).body).toMatchObject({items:[],period:'5y',interval:'1mo',firstValue:null,lastValue:null});
});
it('uses calendar years, selects the actual last monthly sample and retains the true first boundary',async()=>{
 const boundary=(await db.ownerPool.query("SELECT (now()-interval '5 years'+interval '1 hour') AS t")).rows[0].t.toISOString();
 const times=[boundary,'2025-01-01T01:00:00Z','2025-01-02T01:00:00Z','2025-02-03T01:00:00Z'];
 await samples(times);
 const result=await get();expect(result.status).toBe(200);
 expect(result.body.items.map((x:{sampledAt:string})=>x.sampledAt)).toEqual([boundary,'2025-01-02T01:00:00.000Z','2025-02-03T01:00:00.000Z']);
 expect(result.body).toMatchObject({firstValue:'101.00',lastValue:'104.00'});
});
it('selects intraday, daily and weekly buckets without inventing observations and remains bounded',async()=>{
 for(const [period,interval] of [['1d','5m'],['5d','15m'],['1mo','1d'],['3mo','1d'],['6mo','1d'],['1y','1wk'],['5y','1mo']]){
  expect((await get('period='+period)).body.interval).toBe(interval);
 }
 await db.ownerPool.query(`INSERT INTO portfolio_snapshots(account_id,account_sequence,sample_bucket,sampled_at,cash_balance,holdings_value,total_value,unrealized_pl,quality)
 SELECT a.id,1,t,t,100,0,100+n,0,'fresh' FROM accounts a CROSS JOIN generate_series(now()-interval '23 hours',now(),interval '1 minute') WITH ORDINALITY x(t,n) WHERE a.user_id=$1`,[userId]);
 const response=await get('period=1d');expect(response.status).toBe(200);expect(response.body.items.length).toBeLessThanOrEqual(290);
 expect(response.body.items.length).toBeGreaterThan(270);
 expect(response.body.items[0].totalValue).toBe(response.body.firstValue);expect(response.body.items.at(-1).totalValue).toBe(response.body.lastValue);
 const dates=response.body.items.map((x:{sampledAt:string})=>x.sampledAt);expect(dates).toEqual([...dates].sort());
});
it.each([
 ['5d',"date_trunc('hour',now())-interval '1 day'",['0 minutes','1 minute','2 minutes','16 minutes']],
 ['1mo',"date_trunc('day',now())-interval '3 days'",['1 hour','2 hours','3 hours','25 hours']],
 ['1y',"date_trunc('week',now())-interval '3 weeks'",['1 hour','1 day','2 days','8 days']],
])('chooses the final actual sample per bucket for %s while retaining the first sample',async(period,base,offsets)=>{
 const times=(await db.ownerPool.query(`SELECT (${base}+x::interval) AS t FROM unnest($1::text[]) x`,[offsets])).rows.map(row=>row.t.toISOString());
 await samples(times);
 const response=await get('period='+period);expect(response.status).toBe(200);
 expect(response.body.items.map((x:{sampledAt:string})=>x.sampledAt)).toEqual([times[0],times[2],times[3]]);
});
