import type {PoolClient} from 'pg';
import type {DemoSymbol,DemoTrade,PreparedDemo} from './history.js';

export async function recordDemoTrade(c:PoolClient,accountId:string,instrumentId:string,orderId:string,t:DemoTrade):Promise<void>{
  const e=(await c.query<{id:string;native_amount:string;settlement:string;allocated_native_cost:string;allocated_base_cost:string}>(`INSERT INTO executions(order_id,account_id,instrument_id,side,quantity,price,currency,native_amount,fx_rate,settlement,allocated_native_cost,allocated_base_cost,realized_pl,quote_observed_at,fx_observed_at,created_at)
    SELECT $1,$2,$3,$4,$5::numeric,$6::numeric,i.currency,round($5::numeric*$6::numeric,8),$7::numeric,round($5::numeric*$6::numeric*$7::numeric,2),
      CASE WHEN $4='SELL' THEN round(p.native_cost*$5::numeric/p.quantity,8) ELSE 0 END,
      CASE WHEN $4='SELL' THEN round(p.base_cost*$5::numeric/p.quantity,8) ELSE 0 END,
      CASE WHEN $4='SELL' THEN round($5::numeric*$6::numeric*$7::numeric,2)-round(p.base_cost*$5::numeric/p.quantity,8) ELSE 0 END,
      $8,$9,$8 FROM instruments i LEFT JOIN positions p ON p.instrument_id=i.id AND p.account_id=$2 WHERE i.id=$3
    RETURNING id,native_amount::text,settlement::text,allocated_native_cost::text,allocated_base_cost::text`,
  [orderId,accountId,instrumentId,t.side,t.quantity,t.price,t.fx,t.at,t.fxAt])).rows[0]!;
  if(t.side==='BUY')await c.query(`INSERT INTO positions(account_id,instrument_id,quantity,native_cost,base_cost) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(account_id,instrument_id) DO UPDATE SET quantity=positions.quantity+EXCLUDED.quantity,native_cost=positions.native_cost+EXCLUDED.native_cost,base_cost=positions.base_cost+EXCLUDED.base_cost`,[accountId,instrumentId,t.quantity,e.native_amount,e.settlement]);
  else await c.query('UPDATE positions SET quantity=quantity-$3::numeric,native_cost=native_cost-$4::numeric,base_cost=base_cost-$5::numeric WHERE account_id=$1 AND instrument_id=$2',[accountId,instrumentId,t.quantity,e.allocated_native_cost,e.allocated_base_cost]);
  const a=(await c.query<{cash_balance:string;cash_sequence:string}>(`UPDATE accounts SET cash_balance=cash_balance+CASE WHEN $2='BUY' THEN -$3::numeric ELSE $3::numeric END,cash_sequence=cash_sequence+1,valuation_dirty=true WHERE id=$1 RETURNING cash_balance::text,cash_sequence::text`,[accountId,t.side,e.settlement])).rows[0]!;
  await c.query(`INSERT INTO cash_movements(account_id,account_sequence,amount,resulting_balance,reason,execution_id,created_at) VALUES($1,$2,CASE WHEN $3='BUY' THEN -$4::numeric ELSE $4::numeric END,$5,$3,$6,$7)`,[accountId,a.cash_sequence,t.side,e.settlement,a.cash_balance,e.id,t.at]);
}

export async function writeDemoSnapshots(c:PoolClient,accountId:string,ids:Record<DemoSymbol,string>,data:PreparedDemo):Promise<void>{
  await c.query(`INSERT INTO portfolio_snapshots(account_id,account_sequence,sample_bucket,sampled_at,cash_balance,holdings_value,total_value,unrealized_pl,quality,observed_from,observed_to)
    VALUES($1,1,date_trunc('minute',$2::timestamptz),$2,1000000,0,1000000,0,'stale',$2,$2)`,[accountId,data.openingAt]);
  for(const s of data.samples){
    await c.query(`WITH historical AS (
      SELECT instrument_id,sum(CASE WHEN side='BUY' THEN quantity ELSE -quantity END) quantity,
        sum(CASE WHEN side='BUY' THEN settlement ELSE -allocated_base_cost END) cost
      FROM executions WHERE account_id=$1 AND created_at<=$2 GROUP BY instrument_id
    ), prices(id,price) AS (VALUES($3::uuid,$4::numeric*$9::numeric),($5::uuid,$6::numeric*$9::numeric),($7::uuid,$8::numeric)),
    holdings AS (SELECT COALESCE(sum(round(h.quantity*p.price,2)),0) value,COALESCE(sum(h.cost),0) cost FROM historical h JOIN prices p ON p.id=h.instrument_id),
    cash AS (SELECT sum(amount) value,max(account_sequence) sequence FROM cash_movements WHERE account_id=$1 AND created_at<=$2)
    INSERT INTO portfolio_snapshots(account_id,account_sequence,sample_bucket,sampled_at,cash_balance,holdings_value,total_value,unrealized_pl,quality,observed_from,observed_to)
    SELECT $1,c.sequence,date_trunc('minute',$2::timestamptz),$2,c.value,h.value,c.value+h.value,h.value-h.cost,'stale',$10,$11 FROM cash c CROSS JOIN holdings h`,
    [accountId,s.at,ids.AAPL,s.prices.AAPL,ids.MSFT,s.prices.MSFT,ids['RELIANCE.NS'],s.prices['RELIANCE.NS'],s.fx,s.observedFrom,s.observedTo]);
  }
}

export async function demoThresholds(c:PoolClient,data:Pick<PreparedDemo,'reference'>){
  return (await c.query<{aapl:string;msftStop:string;msftLimit:string;reliance:string;alertHigh:string;alertLow:string}>(`SELECT round($1::numeric*.98,2)::text aapl,round($2::numeric*1.02,2)::text "msftStop",round($2::numeric*1.025,2)::text "msftLimit",
    round($3::numeric*.95,2)::text reliance,round($2::numeric*1.05,2)::text "alertHigh",round($3::numeric*.97,2)::text "alertLow"`,[data.reference.AAPL,data.reference.MSFT,data.reference['RELIANCE.NS']])).rows[0]!;
}
