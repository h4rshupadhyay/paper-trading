// Frozen original v1 fixture used only to exercise the guarded v1 upgrade.
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../src/platform/db.js';
import { hashPassword } from '../../src/modules/identity/passwords.js';
import { parseRegisterInput } from '../../src/modules/identity/input.js';
import { parseOrder } from '../../src/modules/trading/input.js';

export type DemoSeedOptions = { password: string; nodeEnv: 'development' | 'test' | 'production'; provider: 'fixture' | 'yfinance' | 'yahoo' };
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
// Synthetic historical facts for this demo account only. No current quote/FX
// observations are written, and no trading eligibility gate is changed.
const trades = [
  {symbol:'AAPL',side:'BUY',quantity:'10',price:'180',fx:'83',nativeCost:'0',baseCost:'0',days:25},
  {symbol:'MSFT',side:'BUY',quantity:'4',price:'325',fx:'83',nativeCost:'0',baseCost:'0',days:20},
  {symbol:'RELIANCE.NS',side:'BUY',quantity:'20',price:'2500',fx:'1',nativeCost:'0',baseCost:'0',days:15},
  {symbol:'AAPL',side:'SELL',quantity:'3',price:'195',fx:'83',nativeCost:'540',baseCost:'44820',days:10},
  {symbol:'RELIANCE.NS',side:'SELL',quantity:'5',price:'2600',fx:'1',nativeCost:'12500',baseCost:'12500',days:5},
] as const;

async function order(c: PoolClient, accountId: string, instrumentId: string, intent: Record<string,unknown>, status: string, days: number, expiresAt?: string): Promise<string> {
  const parsed = parseOrder({instrumentId,...intent,...(expiresAt?{expiresAt}:{})},`demo-v1-${randomUUID()}`);
  const {input,fingerprint,key}=parsed;
  return (await c.query<{id:string}>(`INSERT INTO orders(account_id,instrument_id,idempotency_key,intent_fingerprint,side,type,quantity,limit_price,stop_price,expires_at,status,rejection_reason,created_at,updated_at,completed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11='REJECTED' THEN 'INSUFFICIENT_FUNDS' END,
      now()-make_interval(days=>$12),CASE WHEN $11='EXPIRED' THEN $10::timestamptz ELSE now()-make_interval(days=>$12) END,
      CASE WHEN $11='EXPIRED' THEN $10::timestamptz WHEN $11<>'OPEN' THEN now()-make_interval(days=>$12) END) RETURNING id`,
  [accountId,instrumentId,key,fingerprint,input.side,input.type,input.quantity,input.limitPrice??null,input.stopPrice??null,input.expiresAt??null,status,days])).rows[0]!.id;
}

export async function seedDemo(pool: Pool, options: DemoSeedOptions): Promise<{created:boolean;username:string;userId:string}> {
  if(options.nodeEnv==='production')throw new DemoSeedError('Demo seed is disabled in production');
  if(!['fixture','yfinance','yahoo'].includes(options.provider))throw new DemoSeedError('Unsupported demo market provider');
  const input=parseRegisterInput({username,email,password:options.password});
  const passwordHash=await hashPassword(input.password);
  return withTransaction(pool,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(1480963210)');
    const existing=(await c.query<{id:string;username:string;email:string}>('SELECT id,username,email FROM users WHERE id=$1 OR username=$2 OR email=$3',[demoId,username,email])).rows;
    if(existing.length){
      if(existing.length===1&&existing[0]!.id===demoId&&existing[0]!.username===username&&existing[0]!.email===email)return {created:false,username,userId:demoId};
      throw new DemoSeedError('Demo username or email is already in use by another account');
    }
    await c.query("INSERT INTO users(id,username,email,password_hash,created_at) VALUES($1,$2,$3,$4,now()-interval '30 days')",[demoId,username,email,passwordHash]);
    const accountId=(await c.query<{id:string}>("INSERT INTO accounts(user_id,cash_balance,cash_sequence,valuation_dirty) VALUES($1,1000000,1,true) RETURNING id",[demoId])).rows[0]!.id;
    await c.query("INSERT INTO cash_movements(account_id,account_sequence,amount,resulting_balance,reason,created_at) VALUES($1,1,1000000,1000000,'OPENING_CREDIT',now()-interval '30 days')",[accountId]);
    const ids = {} as Record<Symbol,string>;
    for(const item of catalogue){
      await c.query(`INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,provider,unavailable_reason)
        VALUES($1,$2,$3,$4,1,'EQUITY',$5,$6,$7) ON CONFLICT(provider,symbol) DO NOTHING`,
      [item.symbol,item.name,item.exchange,item.currency,options.provider!=='yahoo',options.provider,options.provider==='yahoo'?'LIVE_MARKET_NOT_VALIDATED':null]);
      const saved=(await c.query<{id:string;currency:string;kind:string;multiplier:string}>('SELECT id,currency,kind,multiplier::text FROM instruments WHERE provider=$1 AND symbol=$2',[options.provider,item.symbol])).rows[0]!;
      if(saved.currency!==item.currency||saved.kind!=='EQUITY'||saved.multiplier!=='1.00000000')throw new DemoSeedError('Existing instrument units do not match demo history');
      ids[item.symbol]=saved.id;
    }
    for(const trade of trades){
      const instrumentId=ids[trade.symbol];
      const orderId=await order(c,accountId,instrumentId,{side:trade.side,type:'MARKET',quantity:trade.quantity},'FILLED',trade.days);
      const execution=(await c.query<{id:string;settlement:string}>(`INSERT INTO executions(order_id,account_id,instrument_id,side,quantity,price,currency,native_amount,fx_rate,settlement,allocated_native_cost,allocated_base_cost,realized_pl,quote_observed_at,fx_observed_at,created_at)
        SELECT $1,$2,$3,$4,$5::numeric,$6::numeric,i.currency,round($5::numeric*$6::numeric,8),$7::numeric,round($5::numeric*$6::numeric*$7::numeric,2),$8::numeric,$9::numeric,
          CASE WHEN $4='SELL' THEN round($5::numeric*$6::numeric*$7::numeric,2)-$9::numeric ELSE 0 END,
          now()-make_interval(days=>$10),now()-make_interval(days=>$10),now()-make_interval(days=>$10) FROM instruments i WHERE i.id=$3 RETURNING id,settlement::text`,
      [orderId,accountId,instrumentId,trade.side,trade.quantity,trade.price,trade.fx,trade.nativeCost,trade.baseCost,trade.days])).rows[0]!;
      const balance=(await c.query<{cash_balance:string;cash_sequence:string}>(`UPDATE accounts SET cash_balance=cash_balance+CASE WHEN $2='BUY' THEN -$3::numeric ELSE $3::numeric END,cash_sequence=cash_sequence+1 WHERE id=$1 RETURNING cash_balance::text,cash_sequence::text`,[accountId,trade.side,execution.settlement])).rows[0]!;
      await c.query(`INSERT INTO cash_movements(account_id,account_sequence,amount,resulting_balance,reason,execution_id,created_at)
        VALUES($1,$2,CASE WHEN $3='BUY' THEN -$4::numeric ELSE $4::numeric END,$5,$3,$6,now()-make_interval(days=>$7))`,[accountId,balance.cash_sequence,trade.side,execution.settlement,balance.cash_balance,execution.id,trade.days]);
    }
    await c.query(`INSERT INTO positions(account_id,instrument_id,quantity,native_cost,base_cost)
      SELECT account_id,instrument_id,sum(CASE WHEN side='BUY' THEN quantity ELSE -quantity END),
        sum(CASE WHEN side='BUY' THEN native_amount ELSE -allocated_native_cost END),sum(CASE WHEN side='BUY' THEN settlement ELSE -allocated_base_cost END)
      FROM executions WHERE account_id=$1 GROUP BY account_id,instrument_id`,[accountId]);
    const future=new Date(Date.now()+30*86400000).toISOString();
    await order(c,accountId,ids.AAPL,{side:'BUY',type:'LIMIT',quantity:'1',limitPrice:'1'},'OPEN',0,future);
    await order(c,accountId,ids['RELIANCE.NS'],{side:'SELL',type:'STOP',quantity:'1',stopPrice:'1'},'OPEN',0,future);
    await order(c,accountId,ids.MSFT,{side:'BUY',type:'STOP_LIMIT',quantity:'1',stopPrice:'100000',limitPrice:'99999'},'OPEN',0,future);
    await order(c,accountId,ids.AAPL,{side:'BUY',type:'LIMIT',quantity:'1',limitPrice:'190'},'CANCELLED',3);
    await order(c,accountId,ids.MSFT,{side:'BUY',type:'LIMIT',quantity:'1',limitPrice:'1'},'EXPIRED',2,new Date(Date.now()-86400000).toISOString());
    await order(c,accountId,ids.AAPL,{side:'BUY',type:'MARKET',quantity:'100000000'},'REJECTED',1);
    const defaultFolder=(await c.query<{id:string}>("INSERT INTO watchlist_folders(user_id,name,is_default) VALUES($1,'Default',true) RETURNING id",[demoId])).rows[0]!.id;
    const research=(await c.query<{id:string}>("INSERT INTO watchlist_folders(user_id,name) VALUES($1,'Research') RETURNING id",[demoId])).rows[0]!.id;
    for(const item of catalogue)await c.query('INSERT INTO watchlist_entries(user_id,folder_id,instrument_id) VALUES($1,$2,$3)',[demoId,item.symbol==='RELIANCE.NS'?defaultFolder:research,ids[item.symbol]]);
    await c.query(`INSERT INTO notes(user_id,instrument_id,title,body) VALUES($1,$2,'Demo: investment thesis','Example research note. Seeded trades and portfolio history are synthetic; current quotes use the normal market provider.'),
      ($1,NULL,'Demo: trading journal','Review the filled buys, partial sales, pending orders and price alerts. This account can be edited like any other account.')`,[demoId,ids.AAPL]);
    await c.query("INSERT INTO price_alerts(user_id,instrument_id,condition,target_price) VALUES($1,$2,'ABOVE',100000),($1,$3,'BELOW',1)",[demoId,ids.MSFT,ids['RELIANCE.NS']]);
    const alert=(await c.query<{id:string}>("INSERT INTO price_alerts(user_id,instrument_id,condition,target_price,active,triggered_at,triggered_observed_at,created_at) VALUES($1,$2,'ABOVE',195,false,now()-interval '10 days',now()-interval '10 days',now()-interval '11 days') RETURNING id",[demoId,ids.AAPL])).rows[0]!;
    await c.query("INSERT INTO notifications(user_id,alert_id,message,created_at) VALUES($1,$2,'Demo history: AAPL reached USD 195.',now()-interval '10 days')",[demoId,alert.id]);
    for(const [days,sequence,cash,holdings,pl] of [
      [29,1,'1000000','0','0'],[24,2,'850600','149400','0'],[19,3,'742700','257300','0'],
      [14,4,'692700','307300','0'],[9,5,'741255','271195','8715'],[1,6,'754255','265175','15195'],
    ] as const)await c.query(`INSERT INTO portfolio_snapshots(account_id,account_sequence,sample_bucket,sampled_at,cash_balance,holdings_value,total_value,unrealized_pl,quality,observed_from,observed_to)
      VALUES($1,$2,date_trunc('minute',now()-make_interval(days=>$3)),now()-make_interval(days=>$3),$4,$5,$4::numeric+$5::numeric,$6,'fresh',now()-make_interval(days=>$3),now()-make_interval(days=>$3))`,[accountId,sequence,days,cash,holdings,pl]);
    return {created:true,username,userId:demoId};
  });
}
