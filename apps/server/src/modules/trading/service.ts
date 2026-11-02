import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { refreshInstrument } from '../market-data/service.js';
import { parseOrder, requireId } from './input.js';

export type OrderView={id:string;instrumentId:string;symbol:string;currency:string;quantity:string;side:string;type:string;status:string;limitPrice:string|null;stopPrice:string|null;expiresAt:Date|null;rejectionReason:string|null;createdAt:Date;executionPrice:string|null;baseSettlement:string|null;completedAt:Date|null};
export const orderProjection=`o.id,o.instrument_id AS "instrumentId",i.symbol,i.currency,o.quantity::text,o.side,o.type,o.status,
 o.limit_price::text AS "limitPrice",o.stop_price::text AS "stopPrice",o.expires_at AS "expiresAt",o.rejection_reason AS "rejectionReason",o.created_at AS "createdAt",o.completed_at AS "completedAt",
 (SELECT e.price::text FROM executions e WHERE e.order_id=o.id) AS "executionPrice",
 (SELECT e.settlement::text FROM executions e WHERE e.order_id=o.id) AS "baseSettlement"`;
type StoredOrder={id:string;account_id:string;instrument_id:string;quantity:string;side:string;type:string;status:string;limit_price:string|null;stop_price:string|null;expires_at:Date|null;intent_fingerprint:string;expired:boolean};
type Account={id:string;cash_balance:string;cash_sequence:string;active:boolean};
type Observation={price:string;currency:string;fx_rate:string;quote_observed_at:string;fx_observed_at:string;eligible:boolean};
const live=(status:string)=>status==='OPEN'||status==='TRIGGERED';
async function retry<T>(work:()=>Promise<T>):Promise<T> {
  for(let attempt=0;;attempt++)try{return await work();}catch(error){
    const code=typeof error==='object'&&error!==null&&'code'in error?error.code:null;
    if(attempt>=2||!['40001','40P01'].includes(String(code)))throw error;
    await new Promise(resolve=>setTimeout(resolve,10+Math.floor(Math.random()*30)*(attempt+1)));
  }
}
async function lockAccount(c:PoolClient,userId:string,skip=false):Promise<Account> {
  const row=(await c.query<Account>(`SELECT a.id,a.cash_balance::text,a.cash_sequence::text,u.active FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1 FOR UPDATE OF a ${skip?'SKIP LOCKED':''}`,[userId])).rows[0];
  if(!row)throw new AppError(404,'ACCOUNT_NOT_FOUND','Account not found');return row;
}
async function view(c:PoolClient,id:string):Promise<OrderView>{return (await c.query<OrderView>(`SELECT ${orderProjection} FROM orders o JOIN instruments i ON i.id=o.instrument_id WHERE o.id=$1`,[id])).rows[0]!;}
async function previous(c:PoolClient,accountId:string,key:string,fingerprint:string):Promise<OrderView|null>{
  const found=(await c.query<{id:string;intent_fingerprint:string}>('SELECT id,intent_fingerprint FROM orders WHERE account_id=$1 AND idempotency_key=$2',[accountId,key])).rows[0];
  if(!found)return null;
  if(found.intent_fingerprint!==fingerprint)throw new AppError(409,'IDEMPOTENCY_CONFLICT','Idempotency key already used for a different order');
  return view(c,found.id);
}
async function observation(c:PoolClient,id:string):Promise<Observation|undefined>{
  return (await c.query<Observation>(`SELECT q.price::text,i.currency,CASE WHEN i.currency='INR' THEN 1 ELSE f.rate END::text AS fx_rate,
  q.observed_at::text AS quote_observed_at,(CASE WHEN i.currency='INR' THEN q.observed_at ELSE f.observed_at END)::text AS fx_observed_at,
  COALESCE(i.tradable AND NOT i.paused AND (NOT $2::boolean OR i.provider<>'fixture')
   AND q.provider=i.provider AND q.raw_currency=CASE WHEN i.multiplier=0.01 THEN 'GBp' ELSE i.currency END
   AND q.price=round(q.raw_price*i.multiplier,8) AND q.price>0 AND q.session='REGULAR'
   AND q.observed_at BETWEEN clock_timestamp()-interval '60 seconds' AND clock_timestamp()+interval '5 seconds'
   AND (i.currency='INR' OR (f.provider=i.provider AND f.rate>0 AND f.observed_at BETWEEN clock_timestamp()-interval '24 hours' AND clock_timestamp()+interval '5 seconds')),false) AS eligible
  FROM instruments i LEFT JOIN latest_quotes q ON q.instrument_id=i.id LEFT JOIN latest_fx_rates f ON f.currency=i.currency WHERE i.id=$1`,[id,process.env.NODE_ENV==='production'])).rows[0];
}
async function reject(c:PoolClient,id:string,reason:string):Promise<void>{await c.query(`UPDATE orders SET status='REJECTED',rejection_reason=$2,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[id,reason]);}
async function processOrder(c:PoolClient,account:Account,orderId:string,immediate=false):Promise<void>{
  const o=(await c.query<StoredOrder>(`SELECT *,expires_at<=clock_timestamp() AS expired FROM orders WHERE id=$1 AND account_id=$2 FOR UPDATE`,[orderId,account.id])).rows[0]!;
  if(!live(o.status))return;
  await c.query('UPDATE orders SET evaluated_at=clock_timestamp() WHERE id=$1',[o.id]);
  if(o.expired){await c.query(`UPDATE orders SET status='EXPIRED',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[o.id]);return;}
  // Recheck active state after the account lock: a worker cannot trust candidate selection.
  const active=(await c.query('SELECT id FROM lock_active_user((SELECT user_id FROM accounts WHERE id=$1))',[account.id])).rowCount;
  if(!active){await reject(c,o.id,'ACCOUNT_DISABLED');return;}
  const data=await observation(c,o.instrument_id);
  if(!data?.eligible){if(immediate)throw new AppError(503,'MARKET_DATA_UNAVAILABLE','Fresh regular-session quote and FX required');return;}
  if((o.type==='STOP'||o.type==='STOP_LIMIT')&&o.status==='OPEN'){
    const crossed=(await c.query<{yes:boolean}>(`SELECT CASE WHEN $1='BUY' THEN $2::numeric >= $3::numeric ELSE $2::numeric <= $3::numeric END AS yes`,[o.side,data.price,o.stop_price])).rows[0]!.yes;
    if(!crossed)return;
    await c.query(`UPDATE orders SET status='TRIGGERED',triggered_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[o.id]);
  }
  if(o.type==='LIMIT'||o.type==='STOP_LIMIT'){
    const matches=(await c.query<{yes:boolean}>(`SELECT CASE WHEN $1='BUY' THEN $2::numeric <= $3::numeric ELSE $2::numeric >= $3::numeric END AS yes`,[o.side,data.price,o.limit_price])).rows[0]!.yes;
    if(!matches)return;
  }
  const amounts=(await c.query<{native:string;settlement:string;zero:boolean;native_zero:boolean;overflow:boolean}>(`SELECT round($1::numeric*$2::numeric,8)::text AS native,
   round($1::numeric*$2::numeric*$3::numeric,2)::text AS settlement,
   round($1::numeric*$2::numeric*$3::numeric,2)=0 AS zero,round($1::numeric*$2::numeric,8)=0 AS native_zero,
   round($1::numeric*$2::numeric*$3::numeric,2)>999999999999999999.99 OR round($1::numeric*$2::numeric,8)>99999999999999999999.99999999 AS overflow`,[o.quantity,data.price,data.fx_rate])).rows[0]!;
  if(amounts.zero){await reject(c,o.id,'SETTLEMENT_ZERO');return;}
  if(amounts.native_zero){await reject(c,o.id,'NATIVE_AMOUNT_ZERO');return;}
  if(amounts.overflow){await reject(c,o.id,'NUMERIC_OVERFLOW');return;}
  const position=(await c.query<{quantity:string;native_cost:string;base_cost:string}>('SELECT quantity::text,native_cost::text,base_cost::text FROM positions WHERE account_id=$1 AND instrument_id=$2 FOR UPDATE',[account.id,o.instrument_id])).rows[0];
  const money=(await c.query<{sufficient:boolean;balance:string;overflow:boolean}>(`SELECT CASE WHEN $1='BUY' THEN $2::numeric >= $3::numeric ELSE COALESCE($4::numeric,0)>=$5::numeric END AS sufficient,
   ($2::numeric+CASE WHEN $1='BUY' THEN -$3::numeric ELSE $3::numeric END)::text AS balance,
   $2::numeric+CASE WHEN $1='BUY' THEN -$3::numeric ELSE $3::numeric END>999999999999999999.99 AS overflow`,[o.side,account.cash_balance,amounts.settlement,position?.quantity??null,o.quantity])).rows[0]!;
  if(!money.sufficient){await reject(c,o.id,o.side==='BUY'?'INSUFFICIENT_FUNDS':'INSUFFICIENT_POSITION');return;}
  if(money.overflow){await reject(c,o.id,'NUMERIC_OVERFLOW');return;}
  const costs=(await c.query<{native:string;base:string;pl:string;full:boolean;position_overflow:boolean}>(`WITH costs AS(SELECT
   CASE WHEN $1='SELL' THEN CASE WHEN $2::numeric=$3::numeric THEN $4::numeric ELSE round($4::numeric*$2::numeric/$3::numeric,8) END ELSE 0 END AS native,
   CASE WHEN $1='SELL' THEN CASE WHEN $2::numeric=$3::numeric THEN $5::numeric ELSE round($5::numeric*$2::numeric/$3::numeric,8) END ELSE 0 END AS base)
   SELECT native::text,base::text,CASE WHEN $1='SELL' THEN $6::numeric-base ELSE 0 END::numeric(28,8)::text AS pl,
   $2::numeric=$3::numeric AS full,
   $1='BUY' AND (COALESCE($3::numeric,0)+$2::numeric>9999999999999999.9999 OR COALESCE($4::numeric,0)+$7::numeric>99999999999999999999.99999999 OR COALESCE($5::numeric,0)+$6::numeric>99999999999999999999.99999999) AS position_overflow FROM costs`,[o.side,o.quantity,position?.quantity??null,position?.native_cost??null,position?.base_cost??null,amounts.settlement,amounts.native])).rows[0]!;
  if(costs.position_overflow){await reject(c,o.id,'NUMERIC_OVERFLOW');return;}
  const execution=(await c.query<{id:string}>(`INSERT INTO executions(order_id,account_id,instrument_id,side,quantity,price,currency,native_amount,fx_rate,settlement,allocated_native_cost,allocated_base_cost,realized_pl,quote_observed_at,fx_observed_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,[o.id,account.id,o.instrument_id,o.side,o.quantity,data.price,data.currency,amounts.native,data.fx_rate,amounts.settlement,costs.native,costs.base,costs.pl,data.quote_observed_at,data.fx_observed_at])).rows[0]!;
  if(o.side==='BUY')await c.query(`INSERT INTO positions(account_id,instrument_id,quantity,native_cost,base_cost) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(account_id,instrument_id) DO UPDATE SET quantity=positions.quantity+EXCLUDED.quantity,native_cost=positions.native_cost+EXCLUDED.native_cost,base_cost=positions.base_cost+EXCLUDED.base_cost`,[account.id,o.instrument_id,o.quantity,amounts.native,amounts.settlement]);
  else if(costs.full)await c.query('DELETE FROM positions WHERE account_id=$1 AND instrument_id=$2',[account.id,o.instrument_id]);
  else await c.query('UPDATE positions SET quantity=quantity-$3,native_cost=native_cost-$4,base_cost=base_cost-$5 WHERE account_id=$1 AND instrument_id=$2',[account.id,o.instrument_id,o.quantity,costs.native,costs.base]);
  const updated=(await c.query<{sequence:string}>(`UPDATE accounts SET cash_balance=$2,cash_sequence=cash_sequence+1,valuation_dirty=true WHERE id=$1 RETURNING cash_sequence::text AS sequence`,[account.id,money.balance])).rows[0]!;
  await c.query(`INSERT INTO cash_movements(account_id,account_sequence,amount,resulting_balance,reason,execution_id)
   VALUES($1,$2,CASE WHEN $3='BUY' THEN -$4::numeric ELSE $4::numeric END,$5,$3,$6)`,[account.id,updated.sequence,o.side,amounts.settlement,money.balance,execution.id]);
  await c.query(`UPDATE orders SET status='FILLED',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[o.id]);
  account.cash_balance=money.balance;account.cash_sequence=updated.sequence;
}
export async function submitOrder(pool:Pool,userId:string,value:unknown,idempotencyKey:unknown,deps:{refresh?:(pool:Pool,id:string)=>Promise<void>}={}):Promise<{order:OrderView;replayed:boolean}>{
  requireId(userId);const {input,fingerprint,key}=parseOrder(value,idempotencyKey);
  // Durable replay is checked before all provider I/O, then under the same account lock as submissions.
  const exists=(await pool.query('SELECT o.id FROM orders o JOIN accounts a ON a.id=o.account_id WHERE a.user_id=$1 AND o.idempotency_key=$2',[userId,key])).rowCount;
  if(!exists&&input.type==='MARKET'){
    try {await (deps.refresh??refreshInstrument)(pool,input.instrumentId);}catch{throw new AppError(503,'MARKET_DATA_UNAVAILABLE','Market provider unavailable');}
  }
  return retry(()=>withTransaction(pool,async c=>{
    const account=await lockAccount(c,userId);
    if(!(await c.query('SELECT id FROM lock_active_user($1)',[userId])).rowCount)throw new AppError(403,'ACCOUNT_DISABLED','Account disabled');
    const prior=await previous(c,account.id,key,fingerprint);if(prior)return {order:prior,replayed:true};
    if(input.expiresAt&&(await c.query<{expired:boolean}>('SELECT $1::timestamptz<=clock_timestamp() AS expired',[input.expiresAt])).rows[0]!.expired)throw new AppError(400,'VALIDATION_ERROR','Expiry must be in the future');
    const instrument=(await c.query<{tradable:boolean;paused:boolean;kind:string;provider:string}>('SELECT tradable,paused,kind,provider FROM instruments WHERE id=$1',[input.instrumentId])).rows[0];
    if(!instrument)throw new AppError(404,'INSTRUMENT_NOT_FOUND','Instrument not found');
    if(!instrument.tradable||instrument.paused||instrument.kind!=='EQUITY'||(process.env.NODE_ENV==='production'&&instrument.provider==='fixture'))throw new AppError(409,'INSTRUMENT_UNAVAILABLE','Instrument unavailable for trading');
    const id=(await c.query<{id:string}>(`INSERT INTO orders(account_id,instrument_id,idempotency_key,intent_fingerprint,side,type,quantity,limit_price,stop_price,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[account.id,input.instrumentId,key,fingerprint,input.side,input.type,input.quantity,input.limitPrice??null,input.stopPrice??null,input.expiresAt??null])).rows[0]!.id;
    if(input.type==='MARKET')await processOrder(c,account,id,true);return {order:await view(c,id),replayed:false};
  }));
}
export async function cancelOrder(pool:Pool,userId:string,orderId:string):Promise<OrderView>{
  requireId(userId);requireId(orderId);
  return retry(()=>withTransaction(pool,async c=>{const account=await lockAccount(c,userId);
    const o=(await c.query<{status:string}>('SELECT status FROM orders WHERE id=$1 AND account_id=$2 FOR UPDATE',[orderId,account.id])).rows[0];
    if(!o)throw new AppError(404,'ORDER_NOT_FOUND','Order not found');
    if(!live(o.status))throw new AppError(409,'ORDER_STATE_CONFLICT','Only live orders can be cancelled');
    await c.query(`UPDATE orders SET status='CANCELLED',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[orderId]);return view(c,orderId);
  }));
}
export async function evaluatePending(pool:Pool):Promise<void>{
  const candidates=(await pool.query<{user_id:string;account_id:string}>(`SELECT a.user_id,o.account_id FROM orders o JOIN accounts a ON a.id=o.account_id WHERE o.status IN ('OPEN','TRIGGERED') GROUP BY a.user_id,o.account_id ORDER BY min(o.evaluated_at),o.account_id LIMIT 100`)).rows;
  for(const candidate of candidates)await retry(()=>withTransaction(pool,async c=>{
    const account=(await c.query<Account>(`SELECT a.id,a.cash_balance::text,a.cash_sequence::text,u.active FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=$1 FOR UPDATE OF a SKIP LOCKED`,[candidate.account_id])).rows[0];if(!account)return;
    const ids=(await c.query<{id:string}>(`SELECT id FROM orders WHERE account_id=$1 AND status IN ('OPEN','TRIGGERED') ORDER BY evaluated_at,created_at,id LIMIT 100`,[account.id])).rows;
    for(const {id} of ids)await processOrder(c,account,id);
  }));
}
