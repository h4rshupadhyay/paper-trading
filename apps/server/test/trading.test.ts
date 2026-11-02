import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHarness, type TestHarness } from './harness.js';
import { migrate } from '../src/platform/migrate.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { submitOrder, cancelOrder, evaluatePending } from '../src/modules/trading/service.js';
import { readPortfolio, sampleSnapshots } from '../src/modules/portfolio/service.js';

let h: TestHarness;
let userId: string;
let instrumentId: string;
const quiet = { refresh: async () => {} };
const key = () => randomUUID();
async function price(value: string, currency = 'INR', session = 'REGULAR') {
  await h.ownerPool.query(`UPDATE instruments SET currency=$2 WHERE id=$1`, [instrumentId,currency]);
  await h.ownerPool.query(`INSERT INTO latest_quotes(instrument_id,price,observed_at,fetched_at,session,raw_currency,raw_price,action_key,provider)
    VALUES($1,$2,clock_timestamp(),clock_timestamp(),$3,$4,$2,'none','fixture') ON CONFLICT(instrument_id)
    DO UPDATE SET price=$2,observed_at=clock_timestamp(),fetched_at=clock_timestamp(),session=$3,raw_currency=$4,raw_price=$2`, [instrumentId,value,session,currency]);
}
const buy = (quantity = '1', extra: Record<string,unknown> = {}) => ({ instrumentId,side:'BUY',type:'MARKET',quantity,...extra });
const sell = (quantity = '1', extra: Record<string,unknown> = {}) => ({ instrumentId,side:'SELL',type:'MARKET',quantity,...extra });
async function cash() { return (await h.appPool.query('SELECT cash_balance::text AS cash FROM accounts WHERE user_id=$1',[userId])).rows[0].cash; }
beforeAll(async () => { h=await createHarness(); await migrate(h.ownerPool); });
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  const id=randomUUID().replaceAll('-','');
  userId=(await registerUser(h.appPool,{username:`u${id.slice(0,20)}`,email:`${id}@test.example`,password:'Example1234!'},async ()=>'unused')).user.id;
  instrumentId=(await h.ownerPool.query(`INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,paused,provider)
    VALUES($1,'Fixture','NSE','INR',1,'EQUITY',true,false,'fixture') RETURNING id`,[id])).rows[0].id;
  await price('100');
});
describe('durable trading and valuation', () => {
  it('fills with exact ledger accounting and replays normalized intent during provider outage', async () => {
    const idempotencyKey=key();
    const first=await submitOrder(h.appPool,userId,buy('2.0000'),idempotencyKey,quiet);
    expect(first.order.status).toBe('FILLED'); expect(first.replayed).toBe(false); expect(await cash()).toBe('999800.00');
    const replay=await submitOrder(h.appPool,userId,buy('2'),idempotencyKey,{refresh:async()=>{throw new Error('outage');}});
    expect(replay.replayed).toBe(true); expect(replay.order.id).toBe(first.order.id);
    await expect(submitOrder(h.appPool,userId,buy('3'),idempotencyKey,quiet)).rejects.toMatchObject({status:409});
    expect((await h.appPool.query('SELECT count(*)::int n FROM executions WHERE order_id=$1',[first.order.id])).rows[0].n).toBe(1);
    expect((await h.appPool.query('SELECT sum(amount)::text total FROM cash_movements WHERE account_id=(SELECT id FROM accounts WHERE user_id=$1)',[userId])).rows[0].total).toBe('999800.00');
  });
  it('serializes competing duplicate requests and insufficient combined buys', async () => {
    await price('600000'); const same=key();
    const duplicate=await Promise.all([submitOrder(h.appPool,userId,buy(),same,quiet),submitOrder(h.appPool,userId,buy(),same,quiet)]);
    expect(duplicate[0].order.id).toBe(duplicate[1].order.id);
    const rejected=await submitOrder(h.appPool,userId,buy(),key(),quiet);
    expect(rejected.order).toMatchObject({status:'REJECTED',rejectionReason:'INSUFFICIENT_FUNDS'}); expect(await cash()).toBe('400000.00');
  });
  it('uses proportional native and base bases on partial sells, consumes full remainder, and supports reentry', async () => {
    await price('10','USD'); await h.ownerPool.query(`INSERT INTO latest_fx_rates(currency,rate,observed_at,fetched_at,provider) VALUES('USD',80,now(),now(),'fixture') ON CONFLICT(currency) DO UPDATE SET rate=80,observed_at=now()`);
    await submitOrder(h.appPool,userId,buy('3'),key(),quiet);
    await price('20','USD'); await h.ownerPool.query(`UPDATE latest_fx_rates SET rate=90,observed_at=now() WHERE currency='USD'`);
    await submitOrder(h.appPool,userId,buy('1'),key(),quiet);
    const partial=await submitOrder(h.appPool,userId,sell('1'),key(),quiet);
    let position=(await readPortfolio(h.appPool,userId)).positions[0]!;
    expect(position.nativeCost).toBe('37.50000000'); expect(position.baseCost).toBe('3150.00000000');
    expect((await h.appPool.query(`SELECT realized_pl::text pl FROM executions WHERE order_id=$1`,[partial.order.id])).rows[0].pl).toBe('750.00000000');
    const sold=await Promise.all([submitOrder(h.appPool,userId,sell('3'),key(),quiet),submitOrder(h.appPool,userId,sell('3'),key(),quiet)]);
    expect(sold.map(s=>s.order.status).sort()).toEqual(['FILLED','REJECTED']);
    expect((await readPortfolio(h.appPool,userId)).positions).toHaveLength(0);
    await submitOrder(h.appPool,userId,buy('1'),key(),quiet);
    position=(await readPortfolio(h.appPool,userId)).positions[0]!; expect(position.baseCost).toBe('1800.00000000');
  });
  it('rounds settlements half up and rejects zero and numeric overflow', async () => {
    await price('0.005'); await submitOrder(h.appPool,userId,buy('1'),key(),quiet); expect(await cash()).toBe('999999.99');
    await price('0.00000001'); expect((await submitOrder(h.appPool,userId,buy('0.0001'),key(),quiet)).order.rejectionReason).toBe('SETTLEMENT_ZERO');
    await price('999999999999.99'); expect((await submitOrder(h.appPool,userId,buy('999999999999.9999'),key(),quiet)).order.rejectionReason).toBe('NUMERIC_OVERFLOW');
  });
  it('rolls back every financial row on a fault after execution insertion', async () => {
    await h.ownerPool.query(`CREATE FUNCTION fail_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason='BUY' THEN RAISE EXCEPTION 'injected fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_settlement BEFORE INSERT ON cash_movements FOR EACH ROW EXECUTE FUNCTION fail_settlement()`);
    const k=key();
    try { await expect(submitOrder(h.appPool,userId,buy(),k,quiet)).rejects.toThrow('injected fault'); }
    finally { await h.ownerPool.query('DROP TRIGGER fail_settlement ON cash_movements; DROP FUNCTION fail_settlement()'); }
    expect(await cash()).toBe('1000000.00');
    expect((await h.appPool.query('SELECT count(*)::int n FROM orders WHERE idempotency_key=$1',[k])).rows[0].n).toBe(0);
    expect((await submitOrder(h.appPool,userId,buy(),k,quiet)).order.status).toBe('FILLED');
  });
  it('does not accept unavailable immediate data or bind its idempotency key', async () => {
    const k=key(); await h.ownerPool.query(`UPDATE latest_quotes SET observed_at=now()-interval '61 seconds' WHERE instrument_id=$1`,[instrumentId]);
    await expect(submitOrder(h.appPool,userId,buy(),k,quiet)).rejects.toMatchObject({status:503});
    await price('100','INR','CLOSED'); await expect(submitOrder(h.appPool,userId,buy(),k,quiet)).rejects.toMatchObject({status:503});
    await price('100','USD'); await h.ownerPool.query(`DELETE FROM latest_fx_rates WHERE currency='USD'`); await expect(submitOrder(h.appPool,userId,buy(),k,quiet)).rejects.toMatchObject({status:503});
    await price('100'); expect((await submitOrder(h.appPool,userId,buy(),k,quiet)).order.status).toBe('FILLED');
  });
  it('keeps stop-limit trigger state through a gap, then fills once at the limit', async () => {
    const order=(await submitOrder(h.appPool,userId,buy('1',{type:'STOP_LIMIT',stopPrice:'110',limitPrice:'112'}),key(),quiet)).order;
    await price('120'); await evaluatePending(h.appPool);
    expect((await h.appPool.query('SELECT status FROM orders WHERE id=$1',[order.id])).rows[0].status).toBe('TRIGGERED');
    await price('111'); await Promise.all([evaluatePending(h.appPool),evaluatePending(h.appPool)]);
    expect((await h.appPool.query('SELECT status FROM orders WHERE id=$1',[order.id])).rows[0].status).toBe('FILLED'); expect(await cash()).toBe('999889.00');
  });
  it('expires without prices and rejects disabled accounts without execution', async () => {
    const order=(await submitOrder(h.appPool,userId,buy('1',{type:'LIMIT',limitPrice:'90',expiresAt:new Date(Date.now()+60000).toISOString()}),key(),quiet)).order;
    await h.ownerPool.query(`UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=$1`,[order.id]);
    await h.ownerPool.query('DELETE FROM latest_quotes WHERE instrument_id=$1',[instrumentId]); await evaluatePending(h.appPool);
    expect((await h.appPool.query('SELECT status FROM orders WHERE id=$1',[order.id])).rows[0].status).toBe('EXPIRED');
    const pending=(await submitOrder(h.appPool,userId,buy('1',{type:'LIMIT',limitPrice:'90'}),key(),quiet)).order;
    await h.ownerPool.query('UPDATE users SET active=false WHERE id=$1',[userId]); await evaluatePending(h.appPool);
    expect((await h.appPool.query('SELECT status,rejection_reason FROM orders WHERE id=$1',[pending.id])).rows[0]).toEqual({status:'REJECTED',rejection_reason:'ACCOUNT_DISABLED'});
  });
  it('serializes cancellation versus fill and rejects other-owner cancellation', async () => {
    const order=(await submitOrder(h.appPool,userId,buy('1',{type:'LIMIT',limitPrice:'90'}),key(),quiet)).order;
    await expect(cancelOrder(h.appPool,randomUUID(),order.id)).rejects.toMatchObject({status:404});
    await price('80'); await Promise.allSettled([cancelOrder(h.appPool,userId,order.id),evaluatePending(h.appPool)]);
    const row=(await h.appPool.query('SELECT status FROM orders WHERE id=$1',[order.id])).rows[0]; expect(['CANCELLED','FILLED']).toContain(row.status);
    const n=(await h.appPool.query('SELECT count(*)::int n FROM executions WHERE order_id=$1',[order.id])).rows[0].n; expect(n).toBe(row.status==='FILLED'?1:0);
  });
  it('returns null incomplete valuations and samples only complete durable account versions', async () => {
    await submitOrder(h.appPool,userId,buy(),key(),quiet);
    await h.ownerPool.query('DELETE FROM latest_quotes WHERE instrument_id=$1',[instrumentId]);
    const incomplete=await readPortfolio(h.appPool,userId); expect(incomplete.totalValue).toBeNull(); expect(incomplete.positions[0]!.value).toBeNull(); expect(incomplete.quality).toBe('incomplete');
    await sampleSnapshots(h.appPool); expect((await h.appPool.query('SELECT count(*)::int n FROM portfolio_snapshots WHERE account_id=(SELECT id FROM accounts WHERE user_id=$1)',[userId])).rows[0].n).toBe(0);
    await price('110','INR','CLOSED'); const complete=await readPortfolio(h.appPool,userId); expect(complete.quality).toBe('stale'); expect(complete.totalValue).toBe('1000010.00');
    await Promise.all([sampleSnapshots(h.appPool),sampleSnapshots(h.appPool)]);
    expect((await h.appPool.query('SELECT count(*)::int n FROM portfolio_snapshots WHERE account_id=(SELECT id FROM accounts WHERE user_id=$1)',[userId])).rows[0].n).toBe(1);
    expect((await h.appPool.query('SELECT valuation_dirty dirty FROM accounts WHERE user_id=$1',[userId])).rows[0].dirty).toBe(false);
  });
  it('runtime cannot mutate immutable financial history or unrelated account fields', async () => {
    const order=await submitOrder(h.appPool,userId,buy(),key(),quiet);
    await expect(h.appPool.query('DELETE FROM executions WHERE order_id=$1',[order.order.id])).rejects.toMatchObject({code:'42501'});
    await expect(h.appPool.query('UPDATE cash_movements SET amount=1')).rejects.toMatchObject({code:'42501'});
    await expect(h.appPool.query("UPDATE accounts SET base_currency='INR' WHERE user_id=$1",[userId])).rejects.toMatchObject({code:'42501'});
  });
});

it('rejects a native amount that rounds to zero without leaking a failed constraint',async()=>{
  await price('0.00000001','USD');
  await h.ownerPool.query(`INSERT INTO latest_fx_rates(currency,rate,observed_at,fetched_at,provider) VALUES('USD',100000000000,now(),now(),'fixture') ON CONFLICT(currency) DO UPDATE SET rate=100000000000,observed_at=now()`);
  const result=await submitOrder(h.appPool,userId,buy('0.0001'),key(),quiet);
  expect(result.order).toMatchObject({status:'REJECTED',rejectionReason:'NATIVE_AMOUNT_ZERO'});expect(await cash()).toBe('1000000.00');
});
it('replays a retry whose UUID differs only by letter case as the same normalized intent',async()=>{
  const k=key();const first=await submitOrder(h.appPool,userId,buy(),k,quiet);
  const replay=await submitOrder(h.appPool,userId,{...buy(),instrumentId:instrumentId.toUpperCase()},k,quiet);
  expect(replay.order.id).toBe(first.order.id);expect(replay.replayed).toBe(true);
});
it('starts pending orders OPEN and returns execution display values with completion time',async()=>{
  const pending=await submitOrder(h.appPool,userId,buy('1',{type:'LIMIT',limitPrice:'90'}),key(),quiet);
  expect(pending.order.status).toBe('OPEN');
  const filled=await submitOrder(h.appPool,userId,buy(),key(),quiet);
  expect(filled.order).toMatchObject({executionPrice:'100.00000000',baseSettlement:'100.00',completedAt:expect.any(Date)});
});
it.each(['INDEX','untradable','paused'])('declines %s instruments before accepting a pending order',async(state)=>{
  await h.ownerPool.query(`UPDATE instruments SET kind=$2,tradable=$3,paused=$4 WHERE id=$1`,[instrumentId,state==='INDEX'?'INDEX':'EQUITY',state==='paused',state==='paused']);
  await expect(submitOrder(h.appPool,userId,buy('1',{type:'LIMIT',limitPrice:'90'}),key(),quiet)).rejects.toMatchObject({status:409,code:'INSTRUMENT_UNAVAILABLE'});
});
it('replaces a same-bucket snapshot with the latest real sample and account version',async()=>{
  await submitOrder(h.appPool,userId,buy(),key(),quiet);await sampleSnapshots(h.appPool);
  await price('110');await submitOrder(h.appPool,userId,buy(),key(),quiet);await sampleSnapshots(h.appPool);
  const snapshots=(await h.appPool.query(`SELECT account_sequence::text,total_value::text FROM portfolio_snapshots WHERE account_id=(SELECT id FROM accounts WHERE user_id=$1)`,[userId])).rows;
  expect(snapshots).toEqual([{account_sequence:'3',total_value:'1000010.00'}]);
});
it('makes progress past an unmatched bounded batch so later expiry cannot starve',async()=>{
  const rows=(await h.ownerPool.query(`WITH new_users AS (
    INSERT INTO users(id,username,email,password_hash) SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
      'fairness'||n,'fairness'||n||'@test.example','unused' FROM generate_series(1,101)n RETURNING id
  ),new_accounts AS (
    INSERT INTO accounts(id,user_id,cash_balance,cash_sequence) SELECT id,id,1000000,1 FROM new_users RETURNING id
  ),credits AS (
    INSERT INTO cash_movements(account_id,account_sequence,amount,resulting_balance,reason) SELECT id,1,1000000,1000000,'OPENING_CREDIT' FROM new_accounts RETURNING account_id
  ) INSERT INTO orders(account_id,instrument_id,idempotency_key,intent_fingerprint,side,type,quantity,limit_price,expires_at)
    SELECT account_id,$1,'fairness-key',repeat('a',64),'BUY','LIMIT',1,1,
      CASE WHEN account_id='00000000-0000-4000-8000-000000000101' THEN now()-interval '1 second' END FROM credits RETURNING id,account_id`,[instrumentId])).rows;
  const last=rows.find(r=>r.account_id==='00000000-0000-4000-8000-000000000101')!;
  await evaluatePending(h.appPool);await evaluatePending(h.appPool);
  expect((await h.appPool.query('SELECT status FROM orders WHERE id=$1',[last.id])).rows[0].status).toBe('EXPIRED');
  await h.ownerPool.query("UPDATE orders SET status='CANCELLED' WHERE account_id=ANY($1::uuid[])",[rows.map(r=>r.account_id)]);
  await h.ownerPool.query("UPDATE users SET active=false WHERE id=ANY($1::uuid[])",[rows.map(r=>r.account_id)]);
});
it('database constraints reject non-finite order quantity independently of HTTP validation',async()=>{
 await expect(h.appPool.query(`INSERT INTO orders(account_id,instrument_id,idempotency_key,intent_fingerprint,side,type,quantity)
   SELECT id,$2,$3,repeat('a',64),'BUY','MARKET','NaN' FROM accounts WHERE user_id=$1`,[userId,instrumentId,key()])).rejects.toMatchObject({code:'23514'});
});
it('serializes independent insufficient buys and simultaneous first-position buys',async()=>{
  await price('600000');const attempts=await Promise.all([submitOrder(h.appPool,userId,buy(),key(),quiet),submitOrder(h.appPool,userId,buy(),key(),quiet)]);
  expect(attempts.map(x=>x.order.status).sort()).toEqual(['FILLED','REJECTED']);expect(await cash()).toBe('400000.00');
  await price('100');await Promise.all([submitOrder(h.appPool,userId,buy('2'),key(),quiet),submitOrder(h.appPool,userId,buy('3'),key(),quiet)]);
  const p=(await readPortfolio(h.appPool,userId)).positions[0]!;expect(p.quantity).toBe('6.0000');expect(p.nativeCost).toBe('600500.00000000');
  const ledger=(await h.appPool.query(`SELECT sum(amount)::text balance,count(DISTINCT account_sequence)::int count FROM cash_movements WHERE account_id=(SELECT id FROM accounts WHERE user_id=$1)`,[userId])).rows[0];
  expect(ledger).toEqual({balance:'399500.00',count:4});
});
it('uses normalized major-unit quotes once and preserves exact source observations in executions',async()=>{
 await h.ownerPool.query(`UPDATE instruments SET currency='GBP',multiplier=0.01 WHERE id=$1`,[instrumentId]);
 await h.ownerPool.query(`UPDATE latest_quotes SET price=10,raw_currency='GBp',raw_price=1000 WHERE instrument_id=$1`,[instrumentId]);
 await h.ownerPool.query(`INSERT INTO latest_fx_rates(currency,rate,observed_at,fetched_at,provider) VALUES('GBP',100,now(),now(),'fixture') ON CONFLICT(currency) DO UPDATE SET rate=100,observed_at=now()`);
 const result=await submitOrder(h.appPool,userId,buy(),key(),quiet);expect(await cash()).toBe('999000.00');
 expect((await h.appPool.query(`SELECT price::text,native_amount::text,fx_rate::text,settlement::text,quote_observed_at=(SELECT observed_at FROM latest_quotes WHERE instrument_id=$2) AS quote_matches FROM executions WHERE order_id=$1`,[result.order.id,instrumentId])).rows[0]).toEqual({price:'10.00000000',native_amount:'10.00000000',fx_rate:'100.000000000000',settlement:'1000.00',quote_matches:true});
});
it('rejects stale or future FX, future quotes, and unknown session without accepting an immediate order',async()=>{
 await price('10','USD');await h.ownerPool.query(`INSERT INTO latest_fx_rates(currency,rate,observed_at,fetched_at,provider) VALUES('USD',80,now()-interval '25 hours',now(),'fixture') ON CONFLICT(currency) DO UPDATE SET rate=80,observed_at=now()-interval '25 hours'`);
 const k=key();await expect(submitOrder(h.appPool,userId,buy(),k,quiet)).rejects.toMatchObject({status:503});
 await h.ownerPool.query(`UPDATE latest_fx_rates SET observed_at=now()+interval '6 seconds' WHERE currency='USD'`);await expect(submitOrder(h.appPool,userId,buy(),k,quiet)).rejects.toMatchObject({status:503});
 await h.ownerPool.query(`UPDATE latest_fx_rates SET observed_at=now() WHERE currency='USD'`);await h.ownerPool.query(`UPDATE latest_quotes SET observed_at=now()+interval '6 seconds' WHERE instrument_id=$1`,[instrumentId]);await expect(submitOrder(h.appPool,userId,buy(),k,quiet)).rejects.toMatchObject({status:503});
 await price('10','USD','UNKNOWN');await expect(submitOrder(h.appPool,userId,buy(),k,quiet)).rejects.toMatchObject({status:503});
 await price('10','USD');expect((await submitOrder(h.appPool,userId,buy(),k,quiet)).order.status).toBe('FILLED');
});
it('keeps pending cash unreserved and rejects only an eligible attempted fill that lacks funds',async()=>{
 const pending=await submitOrder(h.appPool,userId,buy('2',{type:'LIMIT',limitPrice:'600000'}),key(),quiet);
 expect(pending.order.status).toBe('OPEN');expect(await cash()).toBe('1000000.00');
 await cancelOrder(h.appPool,userId,pending.order.id);await submitOrder(h.appPool,userId,buy('2'),key(),quiet);
 await price('600000');const waiting=await submitOrder(h.appPool,userId,buy('2',{type:'LIMIT',limitPrice:'500000'}),key(),quiet);
 expect(waiting.order.status).toBe('OPEN');expect(await cash()).toBe('999800.00');
 await price('500000');await evaluatePending(h.appPool);
 expect((await h.appPool.query('SELECT status,rejection_reason FROM orders WHERE id=$1',[waiting.order.id])).rows[0]).toEqual({status:'REJECTED',rejection_reason:'INSUFFICIENT_FUNDS'});
});
it('consumes the last eight-place allocation remainder on a full sell and reconciles realized FX-inclusive P/L',async()=>{
 await price('0.33333333');await submitOrder(h.appPool,userId,buy('3'),key(),quiet);
 await price('0.5');const first=await submitOrder(h.appPool,userId,sell(),key(),quiet);const second=await submitOrder(h.appPool,userId,sell(),key(),quiet);const last=await submitOrder(h.appPool,userId,sell(),key(),quiet);
 const executions=(await h.appPool.query(`SELECT allocated_base_cost::text,realized_pl::text FROM executions WHERE order_id=ANY($1::uuid[]) ORDER BY created_at`,[[first.order.id,second.order.id,last.order.id]])).rows;
 expect(executions).toEqual([{allocated_base_cost:'0.33333333',realized_pl:'0.16666667'},{allocated_base_cost:'0.33333334',realized_pl:'0.16666666'},{allocated_base_cost:'0.33333333',realized_pl:'0.16666667'}]);
 expect((await readPortfolio(h.appPool,userId)).positions).toEqual([]);expect(await cash()).toBe('1000000.50');
});
it('holds the active-user lock until execution commits so deactivation serializes with a fill',async()=>{
 const gate=await h.ownerPool.connect();await gate.query('SELECT pg_advisory_lock(1480963299)');
 await h.ownerPool.query(`CREATE FUNCTION execution_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(1480963299); RETURN NEW; END $$;
  CREATE TRIGGER execution_gate BEFORE INSERT ON executions FOR EACH ROW EXECUTE FUNCTION execution_gate()`);
 let settlement:Promise<unknown>|undefined;let deactivation:Promise<unknown>|undefined;
 try{
  settlement=submitOrder(h.appPool,userId,buy(),key(),quiet);
  const deadline=Date.now()+2000;
  while(!(await h.ownerPool.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=1480963299 AND NOT granted`)).rowCount){if(Date.now()>deadline)throw Error('Execution never reached gate');await new Promise(r=>setTimeout(r,5));}
  let disabled=false;deactivation=h.ownerPool.query('UPDATE users SET active=false WHERE id=$1',[userId]).then(()=>{disabled=true;});
  await new Promise(r=>setTimeout(r,20));expect(disabled).toBe(false);
  await gate.query('SELECT pg_advisory_unlock(1480963299)');await settlement;await deactivation;
  expect((await h.appPool.query(`SELECT count(*)::int n FROM executions WHERE account_id=(SELECT id FROM accounts WHERE user_id=$1)`,[userId])).rows[0].n).toBe(1);
 }finally{await gate.query('SELECT pg_advisory_unlock_all()');await Promise.allSettled([settlement,deactivation]);gate.release();await h.ownerPool.query('DROP TRIGGER execution_gate ON executions; DROP FUNCTION execution_gate()');}
});

it('fails closed for mismatched provider or quote-unit metadata',async()=>{
 await price('10','USD');await h.ownerPool.query(`INSERT INTO latest_fx_rates(currency,rate,observed_at,fetched_at,provider) VALUES('USD',80,now(),now(),'other') ON CONFLICT(currency) DO UPDATE SET rate=80,observed_at=now(),provider='other'`);
 await expect(submitOrder(h.appPool,userId,buy(),key(),quiet)).rejects.toMatchObject({status:503});
 await h.ownerPool.query(`UPDATE latest_fx_rates SET provider='fixture' WHERE currency='USD'`);
 await h.ownerPool.query(`UPDATE latest_quotes SET provider='other' WHERE instrument_id=$1`,[instrumentId]);await expect(submitOrder(h.appPool,userId,buy(),key(),quiet)).rejects.toMatchObject({status:503});
 await h.ownerPool.query(`UPDATE latest_quotes SET provider='fixture',raw_currency='GBp' WHERE instrument_id=$1`,[instrumentId]);await expect(submitOrder(h.appPool,userId,buy(),key(),quiet)).rejects.toMatchObject({status:503});
 await h.ownerPool.query(`UPDATE latest_quotes SET raw_currency='USD',raw_price=1000 WHERE instrument_id=$1`,[instrumentId]);await expect(submitOrder(h.appPool,userId,buy(),key(),quiet)).rejects.toMatchObject({status:503});
});
it('refuses persisted development fixture instruments when running in production',async()=>{
 vi.stubEnv('NODE_ENV','production');
 try{await expect(submitOrder(h.appPool,userId,buy('1',{type:'LIMIT',limitPrice:'90'}),key(),quiet)).rejects.toMatchObject({status:409,code:'INSTRUMENT_UNAVAILABLE'});}
 finally{vi.unstubAllEnvs();}
});
it('returns a qualifying pending limit OPEN with no reservation or immediate fill',async()=>{
 const pending=await submitOrder(h.appPool,userId,buy('2',{type:'LIMIT',limitPrice:'100'}),key(),quiet);
 expect(pending.order.status).toBe('OPEN');expect(await cash()).toBe('1000000.00');
 expect((await h.appPool.query('SELECT count(*)::int n FROM executions WHERE order_id=$1',[pending.order.id])).rows[0].n).toBe(0);
 await evaluatePending(h.appPool);expect((await h.appPool.query('SELECT status FROM orders WHERE id=$1',[pending.order.id])).rows[0].status).toBe('FILLED');
});
