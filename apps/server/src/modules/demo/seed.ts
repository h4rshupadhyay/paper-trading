import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../platform/db.js';
import { hashPassword } from '../identity/passwords.js';
import { parseRegisterInput } from '../identity/input.js';
import {prepareDemoHistory,type DemoSymbol} from './history.js';
import {recordDemoTrade,writeDemoSnapshots,demoThresholds} from './accounting.js';
import { parseOrder } from '../trading/input.js';

export type DemoSeedOptions = { password: string; nodeEnv: 'development' | 'test' | 'production'; provider: 'fixture' | 'yfinance' | 'yahoo'; history: unknown };
export class DemoSeedError extends Error {}
const demoId = 'de000000-0000-4000-8000-000000000001';
const username = 'demo';
const email = 'demo@example.invalid';
type Symbol = 'AAPL' | 'MSFT' | 'RELIANCE.NS';
const catalogue = [
  {symbol:'AAPL',name:'Apple Inc.',exchange:'NMS',currency:'USD'},
  {symbol:'MSFT',name:'Microsoft Corporation',exchange:'NMS',currency:'USD'},
  {symbol:'RELIANCE.NS',name:'Reliance Industries',exchange:'NSI',currency:'INR'},
] as const;
async function order(c: PoolClient, accountId: string, instrumentId: string, intent: Record<string,unknown>, status: string, days: number, expiresAt?: string, at?: string): Promise<string> {
  const parsed = parseOrder({instrumentId,...intent,...(expiresAt?{expiresAt}:{})},`demo-v2-${randomUUID()}`);
  const {input,fingerprint,key}=parsed;
  return (await c.query<{id:string}>(`INSERT INTO orders(account_id,instrument_id,idempotency_key,intent_fingerprint,side,type,quantity,limit_price,stop_price,expires_at,status,rejection_reason,created_at,updated_at,completed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11='REJECTED' THEN 'INSUFFICIENT_FUNDS' END,
      COALESCE($13::timestamptz,now()-make_interval(days=>$12)),CASE WHEN $11='EXPIRED' THEN $10::timestamptz ELSE COALESCE($13::timestamptz,now()-make_interval(days=>$12)) END,
      CASE WHEN $11='EXPIRED' THEN $10::timestamptz WHEN $11<>'OPEN' THEN COALESCE($13::timestamptz,now()-make_interval(days=>$12)) END) RETURNING id`,
  [accountId,instrumentId,key,fingerprint,input.side,input.type,input.quantity,input.limitPrice??null,input.stopPrice??null,input.expiresAt??null,status,days,at??null])).rows[0]!.id;
}

export async function seedDemo(pool: Pool, options: DemoSeedOptions): Promise<{created:boolean;username:string;userId:string}> {
  if(options.nodeEnv==='production')throw new DemoSeedError('Demo seed is disabled in production');
  if(!['fixture','yfinance','yahoo'].includes(options.provider))throw new DemoSeedError('Unsupported demo market provider');
  const data=prepareDemoHistory(options.history);
  const input=parseRegisterInput({username,email,password:options.password});
  const passwordHash=await hashPassword(input.password);
  return withTransaction(pool,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(1480963210)');
    const existing=(await c.query<{id:string;username:string;email:string}>('SELECT id,username,email FROM users WHERE id=$1 OR username=$2 OR email=$3',[demoId,username,email])).rows;
    if(existing.length){
      if(existing.length===1&&existing[0]!.id===demoId&&existing[0]!.username===username&&existing[0]!.email===email)return {created:false,username,userId:demoId};
      throw new DemoSeedError('Demo username or email is already in use by another account');
    }
    await c.query("INSERT INTO users(id,username,email,password_hash,created_at) VALUES($1,$2,$3,$4,$5)",[demoId,username,email,passwordHash,data.openingAt]);
    const accountId=(await c.query<{id:string}>("INSERT INTO accounts(user_id,cash_balance,cash_sequence,valuation_dirty) VALUES($1,1000000,1,true) RETURNING id",[demoId])).rows[0]!.id;
    await c.query("INSERT INTO cash_movements(account_id,account_sequence,amount,resulting_balance,reason,created_at) VALUES($1,1,1000000,1000000,'OPENING_CREDIT',$2)",[accountId,data.openingAt]);
    const ids = {} as Record<Symbol,string>;
    for(const item of catalogue){
      await c.query(`INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,provider,unavailable_reason)
        VALUES($1,$2,$3,$4,1,'EQUITY',$5,$6,$7) ON CONFLICT(provider,symbol) DO NOTHING`,
      [item.symbol,item.name,item.exchange,item.currency,options.provider!=='yahoo',options.provider,options.provider==='yahoo'?'LIVE_MARKET_NOT_VALIDATED':null]);
      const saved=(await c.query<{id:string;currency:string;kind:string;multiplier:string}>('SELECT id,currency,kind,multiplier::text FROM instruments WHERE provider=$1 AND symbol=$2',[options.provider,item.symbol])).rows[0]!;
      if(saved.currency!==item.currency||saved.kind!=='EQUITY'||saved.multiplier!=='1.00000000')throw new DemoSeedError('Existing instrument units do not match demo history');
      ids[item.symbol]=saved.id;
    }
    for(const trade of data.trades){
      const orderId=await order(c,accountId,ids[trade.symbol],{side:trade.side,type:'MARKET',quantity:trade.quantity},'FILLED',0,undefined,trade.at);
      await recordDemoTrade(c,accountId,ids[trade.symbol],orderId,trade);
    }
    const thresholds=await demoThresholds(c,data);
    const future=new Date(Date.now()+30*86400000).toISOString();
    await order(c,accountId,ids.AAPL,{side:'BUY',type:'LIMIT',quantity:'1',limitPrice:thresholds.aapl},'OPEN',0,future);
    await order(c,accountId,ids['RELIANCE.NS'],{side:'SELL',type:'STOP',quantity:'1',stopPrice:thresholds.reliance},'OPEN',0,future);
    await order(c,accountId,ids.MSFT,{side:'BUY',type:'STOP_LIMIT',quantity:'1',stopPrice:thresholds.msftStop,limitPrice:thresholds.msftLimit},'OPEN',0,future);
    await order(c,accountId,ids.AAPL,{side:'BUY',type:'LIMIT',quantity:'1',limitPrice:thresholds.aapl},'CANCELLED',3);
    await order(c,accountId,ids.MSFT,{side:'BUY',type:'LIMIT',quantity:'1',limitPrice:thresholds.msftStop},'EXPIRED',2,new Date(Date.now()-86400000).toISOString());
    const rejected=(await c.query<{quantity:string}>("SELECT (floor(cash_balance/($2::numeric*$3::numeric))+1)::text quantity FROM accounts WHERE id=$1",[accountId,data.reference.AAPL,data.fx])).rows[0]!.quantity;
    await order(c,accountId,ids.AAPL,{side:'BUY',type:'MARKET',quantity:rejected},'REJECTED',1);
    const defaultFolder=(await c.query<{id:string}>("INSERT INTO watchlist_folders(user_id,name,is_default) VALUES($1,'Default',true) RETURNING id",[demoId])).rows[0]!.id;
    const research=(await c.query<{id:string}>("INSERT INTO watchlist_folders(user_id,name) VALUES($1,'Research') RETURNING id",[demoId])).rows[0]!.id;
    for(const item of catalogue)await c.query('INSERT INTO watchlist_entries(user_id,folder_id,instrument_id) VALUES($1,$2,$3)',[demoId,item.symbol==='RELIANCE.NS'?defaultFolder:research,ids[item.symbol]]);
    await c.query(`INSERT INTO notes(user_id,instrument_id,title,body) VALUES($1,$2,'Demo: investment thesis','Example research note. Demo trades are simulated using historical provider daily closes and FX; see the history provenance note. Current quotes use the normal market provider.'),
      ($1,NULL,'Demo: trading journal','Review the filled buys, partial sales, pending orders and price alerts. This account can be edited like any other account.')`,[demoId,ids.AAPL]);
    await c.query("INSERT INTO price_alerts(user_id,instrument_id,condition,target_price) VALUES($1,$2,'ABOVE',$4),($1,$3,'BELOW',$5)",[demoId,ids.MSFT,ids['RELIANCE.NS'],thresholds.alertHigh,thresholds.alertLow]);
    const sale=data.trades[3]!;
    const alert=(await c.query<{id:string}>("INSERT INTO price_alerts(user_id,instrument_id,condition,target_price,active,triggered_at,triggered_observed_at,created_at) VALUES($1,$2,'ABOVE',$3,false,$4,$4,$4::timestamptz-interval '1 day') RETURNING id",[demoId,ids.AAPL,sale.price,sale.at])).rows[0]!;
    await c.query("INSERT INTO notifications(user_id,alert_id,message,created_at) VALUES($1,$2,$3,$4)",[demoId,alert.id,`Demo history: AAPL daily reference close was USD ${sale.price} on ${sale.sessionDate}.`,sale.at]);
    await writeDemoSnapshots(c,accountId,ids as Record<DemoSymbol,string>,data);
    await c.query("INSERT INTO notes(user_id,title,body) VALUES($1,'Demo: history provenance',$2)",[demoId,data.provenance]);
    return {created:true,username,userId:demoId};
  });
}
