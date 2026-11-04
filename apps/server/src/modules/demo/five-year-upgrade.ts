import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {withTransaction} from '../../platform/db.js';
import {reconcileAccount} from '../accounts/reconciliation.js';
import {parseOrder} from '../trading/input.js';
import {hashPassword} from '../identity/passwords.js';
import {parseRegisterInput} from '../identity/input.js';
import {prepareDemoHistory,type DemoSymbol} from './history.js';
import {prepareFiveYearHistory,type FiveYearPrepared} from './five-year.js';
import {recordDemoTrade,demoThresholds} from './accounting.js';
import {recordAccountAction,writeFiveYearSnapshots} from './five-year-accounting.js';

const demoId='de000000-0000-4000-8000-000000000001';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const catalogue=[['AAPL','Apple Inc.','NMS','USD'],['MSFT','Microsoft Corporation','NMS','USD'],['RELIANCE.NS','Reliance Industries','NSI','INR']] as const;
async function fillOrder(c:PoolClient,accountId:string,instrumentId:string,t:FiveYearPrepared['trades'][number]){
  const p=parseOrder({instrumentId,side:t.side,type:'MARKET',quantity:t.quantity},`demo-v3-${randomUUID()}`);
  return (await c.query<{id:string}>(`INSERT INTO orders(account_id,instrument_id,idempotency_key,intent_fingerprint,side,type,quantity,status,created_at,updated_at,completed_at)
    VALUES($1,$2,$3,$4,$5,'MARKET',$6,'FILLED',$7,$7,$7) RETURNING id`,[accountId,instrumentId,p.key,p.fingerprint,t.side,t.quantity,t.at])).rows[0]!.id;
}
async function replay(c:PoolClient,id:string,ids:Record<DemoSymbol,string>,data:FiveYearPrepared){
  const events=[...data.trades.map(t=>({at:t.at,priority:2,trade:t})),...data.actions.map(action=>({at:action.at,priority:action.kind==='SPLIT'?0:1,action}))].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.priority-b.priority);
  for(const event of events){
    if('trade' in event){const t=event.trade;await recordDemoTrade(c,id,ids[t.symbol],await fillOrder(c,id,ids[t.symbol],t),t);}
    else await recordAccountAction(c,id,ids[event.action.symbol],event.action);
  }
  await writeFiveYearSnapshots(c,id,ids,data);
  const accounting=(await c.query(`SELECT jsonb_build_object('cash',(SELECT jsonb_agg(to_jsonb(m) ORDER BY account_sequence) FROM cash_movements m WHERE account_id=$1),
    'positions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY instrument_id) FROM positions p WHERE account_id=$1),'actions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY effective_at,id) FROM account_actions a WHERE account_id=$1)) value`,[id])).rows[0]!.value;
  const staged=(await c.query("SELECT cash_balance::text AS cash,(SELECT count(*)::int FROM executions WHERE account_id=$1) trades,(SELECT count(*)::int FROM account_actions WHERE account_id=$1) actions,(SELECT COALESCE(sum(base_amount),0)::text FROM account_actions WHERE account_id=$1 AND kind='DIVIDEND') dividend_income FROM accounts WHERE id=$1",[id])).rows[0];
  await c.query('INSERT INTO demo_history_versions(account_id,version,source_digest,accounting_digest,provenance) VALUES($1,3,$2,$3,$4)',[id,hash(data.history),hash(accounting),JSON.stringify({source:'yfinance',fetchedAt:data.history.fetchedAt,openingAt:data.openingAt,endAt:data.samples.at(-1)!.at,conventions:data.provenance,summary:staged})]);
  await c.query("INSERT INTO notes(user_id,title,body) VALUES($1,'Demo: five-year history provenance',$2)",[demoId,data.provenance]);
  const thresholds=await demoThresholds(c,data);
  const cash=(await c.query<{cash:string;affordable:boolean}>(`SELECT cash_balance::text cash,cash_balance>=($2::numeric+$3::numeric)*$4::numeric affordable FROM accounts WHERE id=$1`,[id,thresholds.aapl,thresholds.msftLimit,data.fx])).rows[0]!;
  if(!cash.affordable)throw new Error('Five-year strategy leaves insufficient cash for demo pending orders');
  return {cashBalance:cash.cash,thresholds};
}
async function knownV2(c:PoolClient,id:string,priorHistory:unknown){
  if(!priorHistory||typeof priorHistory!=='object'||!('fetchedAt' in priorHistory)||typeof priorHistory.fetchedAt!=='string')throw Error('Prior v2 source artifact is required');
  const prior=prepareDemoHistory(priorHistory,Date.parse(priorHistory.fetchedAt));
  const actual=(await c.query(`SELECT e.*,i.symbol,o.idempotency_key,o.intent_fingerprint,o.type,o.status,o.created_at order_at,o.completed_at,o.quantity order_quantity
    FROM executions e JOIN instruments i ON i.id=e.instrument_id JOIN orders o ON o.id=e.order_id WHERE e.account_id=$1 ORDER BY e.created_at`,[id])).rows;
  if(actual.length!==5||(await c.query('SELECT 1 FROM account_actions WHERE account_id=$1 LIMIT 1',[id])).rowCount)throw Error('Demo financial history has changed from recognized v2 seed');
  for(const t of prior.trades){
    const e=actual.find(e=>e.symbol===t.symbol&&e.side===t.side);
    if(!e||!e.idempotency_key.startsWith('demo-v2-')||e.type!=='MARKET'||e.status!=='FILLED'||new Date(e.created_at).toISOString()!==new Date(t.at).toISOString()||new Date(e.order_at).toISOString()!==new Date(t.at).toISOString()||new Date(e.completed_at).toISOString()!==new Date(t.at).toISOString())throw Error('Demo financial history has changed from recognized v2 seed');
    const parsed=parseOrder({instrumentId:e.instrument_id,side:t.side,type:'MARKET',quantity:t.quantity},e.idempotency_key);
    if(parsed.fingerprint!==e.intent_fingerprint)throw Error('Demo order intent has changed');
    const buy=prior.trades.find(x=>x.symbol===t.symbol&&x.side==='BUY')!;
    const valid=(await c.query<{valid:boolean}>(`SELECT $1::numeric=$2::numeric AND $1::numeric=$3::numeric AND $4::numeric=$5::numeric AND $6::numeric=$7::numeric
      AND $8::numeric=round($2::numeric*$5::numeric,8) AND $9::numeric=round($2::numeric*$5::numeric*$7::numeric,2)
      AND $10::timestamptz=$11::timestamptz AND $12::timestamptz=$13::timestamptz
      AND $14::numeric=CASE WHEN $15='SELL' THEN round($16::numeric*$17::numeric*$2::numeric/$16::numeric,8) ELSE 0 END
      AND $18::numeric=CASE WHEN $15='SELL' THEN round(round($16::numeric*$17::numeric*$19::numeric,2)*$2::numeric/$16::numeric,8) ELSE 0 END
      AND $20::numeric=CASE WHEN $15='SELL' THEN $9::numeric-$18::numeric ELSE 0 END valid`,
    [e.quantity,t.quantity,e.order_quantity,e.price,t.price,e.fx_rate,t.fx,e.native_amount,e.settlement,e.quote_observed_at,t.at,e.fx_observed_at,t.fxAt,e.allocated_native_cost,t.side,buy.quantity,buy.price,e.allocated_base_cost,buy.fx,e.realized_pl])).rows[0]!.valid;
    if(!valid)throw Error('Demo financial history has changed from recognized v2 seed');
  }
  // Account lock protects against trades; this pool-free statement verifies
  // the maintained ledger and costs without acquiring another connection.
  const projection=(await c.query<{valid:boolean}>(`SELECT a.cash_sequence=6 AND a.cash_balance=(SELECT sum(amount) FROM cash_movements WHERE account_id=$1)
    AND (SELECT count(*) FROM cash_movements WHERE account_id=$1)=6
    AND NOT EXISTS(SELECT 1 FROM (SELECT m.*,sum(amount) OVER(ORDER BY account_sequence) expected FROM cash_movements m WHERE account_id=$1) m WHERE resulting_balance<>expected)
    AND NOT EXISTS(SELECT 1 FROM executions e LEFT JOIN cash_movements m ON m.execution_id=e.id WHERE e.account_id=$1 AND (m.id IS NULL OR m.amount<>CASE WHEN e.side='BUY' THEN -e.settlement ELSE e.settlement END OR m.reason<>e.side OR m.account_id<>$1 OR m.created_at<>e.created_at))
    AND (SELECT created_at FROM cash_movements WHERE account_id=$1 AND account_sequence=1)=$2::timestamptz
    AND (SELECT count(*) FROM positions WHERE account_id=$1)=3
    AND NOT EXISTS(SELECT 1 FROM positions p JOIN (SELECT instrument_id,sum(CASE WHEN side='BUY' THEN quantity ELSE -quantity END) quantity,sum(CASE WHEN side='BUY' THEN native_amount ELSE -allocated_native_cost END) native_cost,sum(CASE WHEN side='BUY' THEN settlement ELSE -allocated_base_cost END) base_cost FROM executions WHERE account_id=$1 GROUP BY instrument_id) e USING(instrument_id) WHERE p.account_id=$1 AND (p.quantity<>e.quantity OR p.native_cost<>e.native_cost OR p.base_cost<>e.base_cost)) valid FROM accounts a WHERE id=$1`,[id,prior.openingAt])).rows[0]!.valid;
  if(!projection||!(await reconcileAccount(c,demoId)).balanced)throw Error('Demo ledger or positions have changed from recognized v2 seed');
}

export async function upgradeFiveYearDemo(pool:Pool,options:{nodeEnv:'development'|'test'|'production';history:unknown;priorHistory?:unknown;backup:(value:unknown)=>Promise<void>}):Promise<{updated:boolean;cashBalance?:string}>{
  if(options.nodeEnv==='production')throw Error('Five-year demo upgrade is disabled in production');
  const data=prepareFiveYearHistory(options.history);
  return withTransaction(pool,async c=>{
    if(!(await c.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(1480963205) locked')).rows[0]!.locked)throw Error('Stop the worker before the five-year upgrade');
    await c.query('SELECT pg_advisory_xact_lock(1480963210)');
    const account=(await c.query<{id:string}>("SELECT a.id FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.id=$1 AND u.username='demo' AND u.email='demo@example.invalid' AND u.active FOR UPDATE OF a",[demoId])).rows[0];if(!account)throw Error('Reserved demo not found');
    const id=account.id;
    if((await c.query('SELECT 1 FROM demo_history_versions WHERE account_id=$1 AND version>=3',[id])).rowCount)return {updated:false};
    await c.query('SELECT id FROM orders WHERE account_id=$1 FOR UPDATE',[id]);
    await knownV2(c,id,options.priorHistory);
    const prior=prepareDemoHistory(options.priorHistory,Date.parse((options.priorHistory as {fetchedAt:string}).fetchedAt));
    const rows:Record<string,unknown>={version:3,history:data.history,priorHistory:options.priorHistory,preview:{trades:data.trades.length,sourceActions:data.actions.length,samples:data.samples.length,from:data.openingAt,to:data.samples.at(-1)!.at}};
    for(const table of ['accounts','orders','executions','cash_movements','positions','account_actions','portfolio_snapshots'])rows[table]=(await c.query(`SELECT row_to_json(t) value FROM ${table} t WHERE ${table==='accounts'?'id':'account_id'}=$1`,[id])).rows.map(r=>r.value);
    for(const table of ['notes','price_alerts','notifications'])rows[table]=(await c.query(`SELECT row_to_json(t) value FROM ${table} t WHERE user_id=$1`,[demoId])).rows.map(r=>r.value);
    await options.backup(rows);
    const ids=Object.fromEntries((await c.query('SELECT DISTINCT i.symbol,i.id FROM executions e JOIN instruments i ON i.id=e.instrument_id WHERE e.account_id=$1',[id])).rows.map(r=>[r.symbol,r.id])) as Record<DemoSymbol,string>;
    await c.query('DELETE FROM portfolio_snapshots WHERE account_id=$1',[id]);await c.query('DELETE FROM positions WHERE account_id=$1',[id]);
    await c.query('DELETE FROM cash_movements WHERE account_id=$1 AND account_sequence>1',[id]);await c.query('DELETE FROM executions WHERE account_id=$1',[id]);
    await c.query("DELETE FROM orders WHERE account_id=$1 AND status='FILLED' AND idempotency_key LIKE 'demo-v2-%'",[id]);
    await c.query('UPDATE accounts SET cash_balance=1000000,cash_sequence=1,valuation_dirty=true WHERE id=$1',[id]);await c.query('UPDATE cash_movements SET created_at=$2 WHERE account_id=$1 AND account_sequence=1',[id,data.openingAt]);
    await c.query("UPDATE notes SET title='Demo: previous one-month history (archived)',updated_at=now() WHERE user_id=$1 AND title='Demo: history provenance' AND body=$2",[demoId,prior.provenance]);
    const result=await replay(c,id,ids,data);
    return {updated:true,cashBalance:result.cashBalance};
  });
}

export async function seedFiveYearDemo(pool:Pool,options:{nodeEnv:'development'|'test'|'production';provider:'fixture'|'yfinance'|'yahoo';password:string;history:unknown}):Promise<{created:boolean;username:string;userId:string}>{
  if(options.nodeEnv==='production'||options.provider==='yahoo')throw Error('Five-year demo creation is unavailable in this environment');
  const data=prepareFiveYearHistory(options.history),input=parseRegisterInput({username:'demo',email:'demo@example.invalid',password:options.password}),passwordHash=await hashPassword(input.password);
  return withTransaction(pool,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(1480963210)');
    const existing=(await c.query('SELECT id,username,email FROM users WHERE id=$1 OR username=$2 OR email=$3',[demoId,input.username,input.email])).rows;
    if(existing.length){if(existing.length===1&&existing[0]!.id===demoId&&existing[0]!.username==='demo'&&existing[0]!.email===input.email)return {created:false,username:'demo',userId:demoId};throw Error('Demo identity already in use');}
    await c.query('INSERT INTO users(id,username,email,password_hash) VALUES($1,$2,$3,$4)',[demoId,input.username,input.email,passwordHash]);
    const id=(await c.query<{id:string}>('INSERT INTO accounts(user_id,cash_balance,cash_sequence,valuation_dirty) VALUES($1,1000000,1,true) RETURNING id',[demoId])).rows[0]!.id;
    await c.query("INSERT INTO cash_movements(account_id,account_sequence,amount,resulting_balance,reason,created_at) VALUES($1,1,1000000,1000000,'OPENING_CREDIT',$2)",[id,data.openingAt]);
    const ids={} as Record<DemoSymbol,string>;
    for(const [symbol,name,exchange,currency] of catalogue){
      await c.query("INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,provider) VALUES($1,$2,$3,$4,1,'EQUITY',true,$5) ON CONFLICT(provider,symbol) DO NOTHING",[symbol,name,exchange,currency,options.provider]);
      const row=(await c.query('SELECT id,currency,multiplier::text,kind FROM instruments WHERE provider=$1 AND symbol=$2',[options.provider,symbol])).rows[0]!;
      if(row.currency!==currency||row.multiplier!=='1.00000000'||row.kind!=='EQUITY')throw Error('Demo instrument units conflict');ids[symbol]=row.id;
    }
    const {thresholds}=await replay(c,id,ids,data);
    await c.query("INSERT INTO notes(user_id,title,body) VALUES($1,'Demo: investment thesis','Research the businesses and valuation before buying. Simulated fills use provider daily closes.'),($1,'Demo: trading journal','Five years of quarterly buys and partial sales, with split and gross ex-date dividend accounting. See the five-year history provenance note.')",[demoId]);
    await c.query("INSERT INTO price_alerts(user_id,instrument_id,condition,target_price) VALUES($1,$2,'ABOVE',$4),($1,$3,'BELOW',$5)",[demoId,ids.MSFT,ids['RELIANCE.NS'],thresholds.alertHigh,thresholds.alertLow]);
    const folder=(await c.query<{id:string}>("INSERT INTO watchlist_folders(user_id,name,is_default) VALUES($1,'Default',true) RETURNING id",[demoId])).rows[0]!.id;
    for(const [symbol] of catalogue)await c.query('INSERT INTO watchlist_entries(user_id,folder_id,instrument_id) VALUES($1,$2,$3)',[demoId,folder,ids[symbol]]);
    for(const [symbol,type,limit,stop] of [['AAPL','LIMIT',thresholds.aapl,null],['MSFT','STOP_LIMIT',thresholds.msftLimit,thresholds.msftStop],['RELIANCE.NS','STOP',null,thresholds.reliance]] as const){
      const expiresAt=new Date(Date.now()+30*86400000).toISOString(),p=parseOrder({instrumentId:ids[symbol],side:symbol==='RELIANCE.NS'?'SELL':'BUY',type,quantity:'1',...(limit?{limitPrice:limit}:{}),...(stop?{stopPrice:stop}:{}),expiresAt},`demo-v3-${randomUUID()}`);
      await c.query("INSERT INTO orders(account_id,instrument_id,idempotency_key,intent_fingerprint,side,type,quantity,limit_price,stop_price,expires_at) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9)",[id,ids[symbol],p.key,p.fingerprint,p.input.side,type,limit,stop,expiresAt]);
    }
    return {created:true,username:'demo',userId:demoId};
  });
}
