import type {PoolClient} from 'pg';
import type {DemoSymbol} from './history.js';
export type HistoricalAction={symbol:DemoSymbol;kind:'SPLIT'|'DIVIDEND';at:string;sessionDate:string;factor:string;perShare:string;fx:string;fxAt:string};

/** Gross ex-date paper dividends; split changes units, never total cost. */
export async function recordAccountAction(c:PoolClient,accountId:string,instrumentId:string,t:HistoricalAction):Promise<void>{
  const position=(await c.query<{quantity:string}>('SELECT quantity::text FROM positions WHERE account_id=$1 AND instrument_id=$2',[accountId,instrumentId])).rows[0];
  if(!position)return;
  if(t.kind==='SPLIT'){
    const valid=(await c.query<{valid:boolean}>('SELECT $1::numeric*$2::numeric=round($1::numeric*$2::numeric,4) AND $1::numeric*$2::numeric>0 valid',[position.quantity,t.factor])).rows[0]!.valid;
    if(!valid)throw new Error('Unsupported fractional split quantity');
  }
  const action=(await c.query<{id:string;base_amount:string}>(`INSERT INTO account_actions(account_id,instrument_id,kind,source_date,effective_at,quantity_before,quantity_delta,factor,per_share,native_amount,fx_rate,base_amount,fx_observed_at,provider)
    VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $3='SPLIT' THEN $6::numeric*($7::numeric-1) ELSE 0 END,$7,$8,
      CASE WHEN $3='DIVIDEND' THEN round($6::numeric*$8::numeric,8) ELSE 0 END,$9,
      CASE WHEN $3='DIVIDEND' THEN round(round($6::numeric*$8::numeric,8)*$9::numeric,2) ELSE 0 END,$10,'yfinance') RETURNING id,base_amount::text`,
  [accountId,instrumentId,t.kind,t.sessionDate,t.at,position.quantity,t.factor,t.perShare,t.fx,t.fxAt])).rows[0]!;
  if(t.kind==='SPLIT')await c.query('UPDATE positions SET quantity=quantity*$3::numeric WHERE account_id=$1 AND instrument_id=$2',[accountId,instrumentId,t.factor]);
  else{
    const a=(await c.query<{cash_balance:string;cash_sequence:string}>('UPDATE accounts SET cash_balance=cash_balance+$2::numeric,cash_sequence=cash_sequence+1,valuation_dirty=true WHERE id=$1 RETURNING cash_balance::text,cash_sequence::text',[accountId,action.base_amount])).rows[0]!;
    await c.query("INSERT INTO cash_movements(account_id,account_sequence,amount,resulting_balance,reason,action_id,created_at) VALUES($1,$2,$3,$4,'DIVIDEND',$5,$6)",[accountId,a.cash_sequence,action.base_amount,a.cash_balance,action.id,t.at]);
  }
}

export async function writeFiveYearSnapshots(c:PoolClient,accountId:string,ids:Record<DemoSymbol,string>,data:import('./five-year.js').FiveYearPrepared):Promise<void>{
  await c.query(`INSERT INTO portfolio_snapshots(account_id,account_sequence,sample_bucket,sampled_at,cash_balance,holdings_value,total_value,unrealized_pl,quality,observed_from,observed_to)
    VALUES($1,1,date_trunc('minute',$2::timestamptz),$2,1000000,0,1000000,0,'stale',$2,$2)`,[accountId,data.openingAt]);
  await c.query(`WITH samples AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS s(at timestamptz,prices jsonb,fx numeric,"observedFrom" timestamptz,"observedTo" timestamptz)),
    effects AS (
      SELECT instrument_id,created_at at,CASE WHEN side='BUY' THEN quantity ELSE -quantity END quantity,CASE WHEN side='BUY' THEN settlement ELSE -allocated_base_cost END cost
      FROM executions WHERE account_id=$1
      UNION ALL SELECT instrument_id,effective_at,quantity_delta,0 FROM account_actions WHERE account_id=$1
    ), valued AS (
      SELECT s.*,h.value,h.cost,m.cash,m.sequence FROM samples s CROSS JOIN LATERAL (
        SELECT COALESCE(sum(round(p.quantity*CASE WHEN p.instrument_id=$3 THEN (s.prices->>'AAPL')::numeric*s.fx WHEN p.instrument_id=$4 THEN (s.prices->>'MSFT')::numeric*s.fx ELSE (s.prices->>'RELIANCE.NS')::numeric END,2)),0) value,COALESCE(sum(p.cost),0) cost
        FROM (SELECT instrument_id,sum(quantity) quantity,sum(cost) cost FROM effects WHERE at<=s.at GROUP BY instrument_id) p
      ) h CROSS JOIN LATERAL (SELECT sum(amount) cash,max(account_sequence) sequence FROM cash_movements WHERE account_id=$1 AND created_at<=s.at) m
    ) INSERT INTO portfolio_snapshots(account_id,account_sequence,sample_bucket,sampled_at,cash_balance,holdings_value,total_value,unrealized_pl,quality,observed_from,observed_to)
      SELECT $1,sequence,date_trunc('minute',at),at,cash,value,cash+value,value-cost,'stale',"observedFrom","observedTo" FROM valued WHERE at>$5::timestamptz`,
  [accountId,JSON.stringify(data.samples),ids.AAPL,ids.MSFT,data.openingAt]);
}
