import type {Pool,PoolClient} from 'pg';
import {withTransaction} from '../../platform/db.js';
import {parseOrder} from '../trading/input.js';
import {prepareDemoHistory,type DemoSymbol} from './history.js';
import {recordDemoTrade,writeDemoSnapshots,demoThresholds} from './accounting.js';
import {DemoSeedError} from './seed.js';

const demoId='de000000-0000-4000-8000-000000000001';
type SavedOrder={id:string;instrument_id:string;symbol:DemoSymbol;side:string;type:string;quantity:string;limit_price:string|null;stop_price:string|null;expires_at:Date|null;status:string;intent_fingerprint:string;idempotency_key:string};
async function verifyOriginal(c:PoolClient,accountId:string):Promise<void>{
  // Exact v1 amounts, source times, units, ledger and projections. A balanced
  // account alone is insufficient: later trades can also be perfectly balanced.
  const result=(await c.query<{valid:boolean}>(`WITH expected(symbol,side,quantity,price,fx,native_amount,settlement,native_cost,base_cost,pl,days) AS (VALUES
    ('AAPL','BUY',10,180,83,1800,149400,0,0,0,25),('MSFT','BUY',4,325,83,1300,107900,0,0,0,20),
    ('RELIANCE.NS','BUY',20,2500,1,50000,50000,0,0,0,15),('AAPL','SELL',3,195,83,585,48555,540,44820,3735,10),
    ('RELIANCE.NS','SELL',5,2600,1,13000,13000,12500,12500,500,5)
  ), matching AS (
    SELECT e.id FROM executions e JOIN orders o ON o.id=e.order_id JOIN instruments i ON i.id=e.instrument_id
    JOIN users u ON u.id=$2 JOIN expected x ON x.symbol=i.symbol AND x.side=e.side
    WHERE e.account_id=$1 AND o.account_id=$1 AND o.instrument_id=e.instrument_id AND o.side=e.side
      AND o.type='MARKET' AND o.status='FILLED' AND o.quantity=e.quantity AND o.limit_price IS NULL AND o.stop_price IS NULL AND o.expires_at IS NULL
      AND o.idempotency_key LIKE 'demo-v1-%' AND e.quantity=x.quantity AND e.price=x.price AND e.fx_rate=x.fx
      AND e.native_amount=x.native_amount AND e.settlement=x.settlement AND e.allocated_native_cost=x.native_cost AND e.allocated_base_cost=x.base_cost AND e.realized_pl=x.pl
      AND i.currency=CASE WHEN i.symbol='RELIANCE.NS' THEN 'INR' ELSE 'USD' END AND e.currency=i.currency AND i.kind='EQUITY' AND i.multiplier=1 AND i.provider='yfinance'
      AND e.created_at=u.created_at+make_interval(days=>30-x.days) AND e.quote_observed_at=e.created_at AND e.fx_observed_at=e.created_at
      AND o.created_at=e.created_at AND o.updated_at=e.created_at AND o.completed_at=e.created_at
  ), expected_cash(sequence,amount,balance) AS (VALUES(1,1000000,1000000),(2,-149400,850600),(3,-107900,742700),(4,-50000,692700),(5,48555,741255),(6,13000,754255)),
  cash_errors AS (
    SELECT m.id FROM cash_movements m LEFT JOIN expected_cash x ON x.sequence=m.account_sequence LEFT JOIN executions e ON e.id=m.execution_id
    WHERE m.account_id=$1 AND (x.sequence IS NULL OR m.amount<>x.amount OR m.resulting_balance<>x.balance
      OR (m.account_sequence=1 AND (m.reason<>'OPENING_CREDIT' OR m.execution_id IS NOT NULL OR m.created_at<>(SELECT created_at FROM users WHERE id=$2)))
      OR (m.account_sequence>1 AND (e.id IS NULL OR e.account_id<>$1 OR m.reason<>e.side OR abs(m.amount)<>e.settlement OR m.created_at<>e.created_at)))
  ), expected_positions(symbol,quantity,native_cost,base_cost) AS (VALUES('AAPL',7,1260,104580),('MSFT',4,1300,107900),('RELIANCE.NS',15,37500,37500))
  SELECT a.cash_balance=754255 AND a.cash_sequence=6
    AND (SELECT count(*) FROM executions WHERE account_id=$1)=5 AND (SELECT count(*) FROM matching)=5
    AND (SELECT count(*) FROM cash_movements WHERE account_id=$1)=6 AND NOT EXISTS(SELECT 1 FROM cash_errors)
    AND (SELECT count(*) FROM positions WHERE account_id=$1)=3
    AND (SELECT count(*) FROM positions p JOIN instruments i ON i.id=p.instrument_id JOIN expected_positions x ON x.symbol=i.symbol AND p.quantity=x.quantity AND p.native_cost=x.native_cost AND p.base_cost=x.base_cost WHERE p.account_id=$1)=3 AS valid
  FROM accounts a WHERE a.id=$1`,[accountId,demoId])).rows[0];
  if(!result?.valid)throw new DemoSeedError('Demo accounting has changed from the original seed; refusing to replace history');
}

export async function upgradeDemo(pool:Pool,options:{history:unknown;nodeEnv:'development'|'test'|'production';backup:(value:unknown)=>Promise<void>}):Promise<{updated:boolean;cashBalance?:string}>{
  if(options.nodeEnv==='production')throw new DemoSeedError('Demo upgrade is disabled in production');
  const data=prepareDemoHistory(options.history);
  return withTransaction(pool,async c=>{
    // The worker holds this session lock across refresh, order/alert evaluation
    // and sampling. Fence the whole batch before any old valuation can escape.
    const worker=(await c.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(1480963205) locked')).rows[0]!;
    if(!worker.locked)throw new DemoSeedError('Demo worker is active; stop the worker and retry the explicit upgrade');
    await c.query('SELECT pg_advisory_xact_lock(1480963210)');
    const account=(await c.query<{id:string}>("SELECT a.id FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.id=$1 AND u.username='demo' AND u.email='demo@example.invalid' AND u.active FOR UPDATE OF a",[demoId])).rows[0];
    if(!account)throw new DemoSeedError('Reserved demo user not found');
    const id=account.id;
    const orders=(await c.query<SavedOrder>('SELECT o.*,i.symbol FROM orders o JOIN instruments i ON i.id=o.instrument_id WHERE o.account_id=$1 ORDER BY o.created_at,o.id FOR UPDATE OF o',[id])).rows;
    if(orders.some(o=>o.idempotency_key.startsWith('demo-v2-')))return {updated:false};
    await verifyOriginal(c,id);
    const filled=orders.filter(o=>o.status==='FILLED');
    if(filled.length!==5)throw new DemoSeedError('Demo orders have changed from the original seed');
    for(const o of filled){
      const original=parseOrder({instrumentId:o.instrument_id,side:o.side,type:o.type,quantity:o.quantity},o.idempotency_key);
      if(original.fingerprint!==o.intent_fingerprint)throw new DemoSeedError('Original demo order intent has changed');
    }
    const ids=Object.fromEntries(filled.map(o=>[o.symbol,o.instrument_id])) as Record<DemoSymbol,string>;
    await c.query('SELECT id FROM notes WHERE user_id=$1 FOR UPDATE',[demoId]);
    await c.query('SELECT id FROM price_alerts WHERE user_id=$1 FOR UPDATE',[demoId]);
    const backup:Record<string,unknown>={version:1,userId:demoId,createdAt:new Date().toISOString(),history:data.history};
    for(const table of ['accounts','orders','executions','cash_movements','positions','portfolio_snapshots']){
      backup[table]=(await c.query(`SELECT row_to_json(t) value FROM ${table} t WHERE ${table==='accounts'?'id':'account_id'}=$1`,[id])).rows.map(r=>r.value);
    }
    for(const table of ['notes','price_alerts','notifications'])backup[table]=(await c.query(`SELECT row_to_json(t) value FROM ${table} t WHERE user_id=$1`,[demoId])).rows.map(r=>r.value);
    await options.backup(backup); // Must succeed before the first mutation.
    await c.query('DELETE FROM portfolio_snapshots WHERE account_id=$1',[id]);
    await c.query('DELETE FROM positions WHERE account_id=$1',[id]);
    await c.query('DELETE FROM cash_movements WHERE account_id=$1 AND account_sequence>1',[id]);
    await c.query('DELETE FROM executions WHERE account_id=$1',[id]);
    await c.query('UPDATE accounts SET cash_balance=1000000,cash_sequence=1,valuation_dirty=true WHERE id=$1',[id]);
    await c.query('UPDATE cash_movements SET created_at=$2 WHERE account_id=$1 AND account_sequence=1',[id,data.openingAt]);
    for(const t of data.trades){
      const o=filled.find(o=>o.symbol===t.symbol&&o.side===t.side)!;
      await c.query("UPDATE orders SET created_at=$2,updated_at=$2,completed_at=$2,idempotency_key=replace(idempotency_key,'demo-v1-','demo-v2-') WHERE id=$1",[o.id,t.at]);
      await recordDemoTrade(c,id,ids[t.symbol],o.id,t);
    }
    const thresholds=await demoThresholds(c,data);
    for(const o of orders.filter(o=>o.status==='OPEN'&&o.idempotency_key.startsWith('demo-v1-'))){
      const recognized=o.quantity==='1.0000'&&(
        o.symbol==='AAPL'&&o.side==='BUY'&&o.type==='LIMIT'&&o.limit_price==='1.00000000'&&o.stop_price===null||
        o.symbol==='RELIANCE.NS'&&o.side==='SELL'&&o.type==='STOP'&&o.stop_price==='1.00000000'&&o.limit_price===null||
        o.symbol==='MSFT'&&o.side==='BUY'&&o.type==='STOP_LIMIT'&&o.stop_price==='100000.00000000'&&o.limit_price==='99999.00000000');
      if(!recognized)continue;
      const old=parseOrder({instrumentId:o.instrument_id,side:o.side,type:o.type,quantity:o.quantity,...(o.limit_price?{limitPrice:o.limit_price}:{}),...(o.stop_price?{stopPrice:o.stop_price}:{}),...(o.expires_at?{expiresAt:o.expires_at.toISOString()}:{})},o.idempotency_key);
      if(old.fingerprint!==o.intent_fingerprint)continue;
      const parsed=parseOrder({...old.input,...(o.type==='LIMIT'?{limitPrice:thresholds.aapl}:o.type==='STOP'?{stopPrice:thresholds.reliance}:{stopPrice:thresholds.msftStop,limitPrice:thresholds.msftLimit})},o.idempotency_key);
      await c.query('UPDATE orders SET limit_price=$2,stop_price=$3,intent_fingerprint=$4,updated_at=now() WHERE id=$1',[o.id,parsed.input.limitPrice??null,parsed.input.stopPrice??null,parsed.fingerprint]);
    }
    // Only exact untouched seed alert examples are replaced. Cancelled orders
    // and user-authored notes are never rewritten.
    await c.query(`UPDATE price_alerts SET target_price=CASE WHEN instrument_id=$2 THEN $4::numeric ELSE $5::numeric END
      WHERE user_id=$1 AND active AND created_at=(SELECT created_at+interval '30 days' FROM users WHERE id=$1) AND ((instrument_id=$2 AND condition='ABOVE' AND target_price=100000) OR (instrument_id=$3 AND condition='BELOW' AND target_price=1))`,[demoId,ids.MSFT,ids['RELIANCE.NS'],thresholds.alertHigh,thresholds.alertLow]);
    const sale=data.trades[3]!;
    await c.query(`UPDATE notifications n SET message=$2,created_at=$3 FROM price_alerts a WHERE n.alert_id=a.id AND n.user_id=$1 AND a.instrument_id=$4
      AND a.created_at=(SELECT created_at+interval '19 days' FROM users WHERE id=$1) AND n.created_at=(SELECT created_at+interval '20 days' FROM users WHERE id=$1) AND n.message='Demo history: AAPL reached USD 195.' AND a.condition='ABOVE' AND a.target_price=195 AND NOT a.active`,[demoId,`Demo history: AAPL daily reference close was USD ${sale.price} on ${sale.sessionDate}.`,sale.at,ids.AAPL]);
    await c.query("UPDATE price_alerts SET target_price=$3,triggered_at=$4,triggered_observed_at=$4,created_at=$4::timestamptz-interval '1 day' WHERE user_id=$1 AND instrument_id=$2 AND condition='ABOVE' AND target_price=195 AND NOT active AND created_at=(SELECT created_at+interval '19 days' FROM users WHERE id=$1) AND triggered_at=(SELECT created_at+interval '20 days' FROM users WHERE id=$1)",[demoId,ids.AAPL,sale.price,sale.at]);
    await c.query("UPDATE notes SET body=$2,updated_at=now() WHERE user_id=$1 AND created_at=(SELECT created_at+interval '30 days' FROM users WHERE id=$1) AND title='Demo: investment thesis' AND body='Example research note. Seeded trades and portfolio history are synthetic; current quotes use the normal market provider.'",[demoId,'Example research note. Demo trades are simulated using historical provider daily closes and FX; see the history provenance note. Current quotes use the normal market provider.']);
    await writeDemoSnapshots(c,id,ids,data);
    await c.query("INSERT INTO notes(user_id,title,body) VALUES($1,'Demo: history provenance',$2)",[demoId,data.provenance]);
    const cashBalance=(await c.query<{cash_balance:string}>('SELECT cash_balance::text FROM accounts WHERE id=$1',[id])).rows[0]!.cash_balance;
    return {updated:true,cashBalance};
  });
}
