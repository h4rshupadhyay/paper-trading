import { randomUUID,randomBytes,createHash } from 'node:crypto';
import request from 'supertest';
import { beforeAll,afterAll,beforeEach,expect,it } from 'vitest';
import { createHarness,type TestHarness } from './harness.js';
import { migrate } from '../src/platform/migrate.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { csrfForSession } from '../src/modules/identity/sessions.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { createSafeLogger } from '../src/platform/logging.js';
import { submitOrder } from '../src/modules/trading/service.js';
import { sampleSnapshots } from '../src/modules/portfolio/service.js';
let h:TestHarness;let userId:string;let instrumentId:string;let cookie:string;let csrf:string;let app:ReturnType<typeof createApp>;
const origin='https://paper.example';
const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://app:password@127.0.0.1:55439/unused',PUBLIC_ORIGIN:origin,CSRF_SECRET:'a session CSRF secret of at least thirty-two bytes'});
async function identity(){const u=randomUUID().replaceAll('-','');const {user}=await registerUser(h.appPool,{username:u.slice(0,20),email:`${u}@example.com`,password:'unused'},async()=>'unused');
 const token=randomBytes(32).toString('base64url');await h.appPool.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[user.id,createHash('sha256').update(token).digest('hex')]);
 return {userId:user.id,cookie:`paper_session=${token}`,csrf:csrfForSession(token,config.csrfSecret)};}
beforeAll(async()=>{h=await createHarness();await migrate(h.ownerPool);app=createApp({pool:h.appPool,config,logger:createSafeLogger(()=>{})});});
afterAll(async()=>{await h?.close();});
beforeEach(async()=>{({userId,cookie,csrf}=await identity());instrumentId=(await h.ownerPool.query(`INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,paused,provider) VALUES($1,'Fixture','NSE','INR',1,'EQUITY',true,false,'fixture') RETURNING id`,[randomUUID()])).rows[0].id;
 await h.ownerPool.query(`INSERT INTO latest_quotes(instrument_id,price,observed_at,session,raw_currency,raw_price,action_key,provider) VALUES($1,100,now(),'REGULAR','INR',100,'none','fixture')`,[instrumentId]);});
const input=()=>({instrumentId,side:'BUY',type:'LIMIT',quantity:'1',limitPrice:'90'});
it('filters owned orders by status with deterministic pagination and validates status',async()=>{
 const pending=await submitOrder(h.appPool,userId,input(),randomUUID());await submitOrder(h.appPool,userId,{...input(),type:'MARKET',limitPrice:undefined},randomUUID(),{refresh:async()=>{}});
 const response=await request(app).get('/api/orders?status=OPEN&limit=1').set('Cookie',cookie);
 expect(response.status).toBe(200);expect(response.body.items.map((o:{id:string})=>o.id)).toEqual([pending.order.id]);expect(response.body.nextCursor).toBeNull();
 expect((await request(app).get('/api/orders?status=garbage').set('Cookie',cookie)).status).toBe(400);
});
it('accepts a bounded snapshot day range without exposing old samples or other owners',async()=>{
 await submitOrder(h.appPool,userId,{instrumentId,side:'BUY',type:'MARKET',quantity:'1'},randomUUID(),{refresh:async()=>{}});await sampleSnapshots(h.appPool);
 const response=await request(app).get('/api/portfolio/snapshots?days=730').set('Cookie',cookie);expect(response.status).toBe(200);expect(response.body.items).toHaveLength(1);
 await h.ownerPool.query(`UPDATE portfolio_snapshots SET sampled_at=now()-interval '8 days' WHERE account_id=(SELECT id FROM accounts WHERE user_id=$1)`,[userId]);
 expect((await request(app).get('/api/portfolio/snapshots?days=7').set('Cookie',cookie)).body.items).toEqual([]);
 for(const days of ['0','1826','1.5','-1','x'])expect((await request(app).get(`/api/portfolio/snapshots?days=${days}`).set('Cookie',cookie)).status).toBe(400);
});
it('requires Origin and CSRF and scopes details, cancel, executions, and portfolio to their owner',async()=>{
 const o=await submitOrder(h.appPool,userId,input(),randomUUID());const other=await identity();
 expect((await request(app).get(`/api/orders/${o.order.id}`).set('Cookie',other.cookie)).status).toBe(404);
 expect((await request(app).post(`/api/orders/${o.order.id}/cancel`).set('Cookie',other.cookie).set('Origin',origin).set('X-CSRF-Token',other.csrf).send({})).status).toBe(404);
 expect((await request(app).post('/api/orders').set('Cookie',cookie).set('Origin',origin).set('Idempotency-Key',randomUUID()).send(input())).status).toBe(403);
 expect((await request(app).post('/api/orders').set('Cookie',cookie).set('X-CSRF-Token',csrf).set('Idempotency-Key',randomUUID()).send(input())).status).toBe(403);
 const created=await request(app).post('/api/orders').set('Cookie',cookie).set('Origin',origin).set('X-CSRF-Token',csrf).set('Idempotency-Key',randomUUID()).send(input());expect(created.status).toBe(201);expect(created.body.order.status).toBe('OPEN');
 expect((await request(app).get('/api/executions').set('Cookie',other.cookie)).body.items).toEqual([]);
 expect((await request(app).get('/api/portfolio').set('Cookie',other.cookie)).body.account.id).not.toBe((await request(app).get('/api/portfolio').set('Cookie',cookie)).body.account.id);
});
it.each([{quantity:1},{quantity:'1e2'},{quantity:'1.00001'},{quantity:'0'},{limitPrice:'90.000000001'},{type:'MARKET'},{type:'STOP',stopPrice:'110'},{expiresAt:'2000-01-01T00:00:00Z'},{unknown:'x'}])('rejects malformed intent %j before accepting it',async(change)=>{
 const response=await request(app).post('/api/orders').set('Cookie',cookie).set('Origin',origin).set('X-CSRF-Token',csrf).set('Idempotency-Key',randomUUID()).send({...input(),...change});expect(response.status).toBe(400);
});
