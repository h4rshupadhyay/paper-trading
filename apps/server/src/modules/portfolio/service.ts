import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
export type PositionView={instrumentId:string;symbol:string;name:string;currency:string;quantity:string;nativeCost:string;baseCost:string;price:string|null;value:string|null;unrealizedPl:string|null;quality:string;observedAt:string|null};
export type PortfolioView={account:{id:string;baseCurrency:string;cashBalance:string;cashSequence:string};positions:PositionView[];totalValue:string|null;holdingsValue:string|null;unrealizedPl:string|null;quality:string;observedAt:string|null};
type Valuation={portfolio:PortfolioView;observed_from:string|null;observed_to:string|null;sampled_at:string};
// One statement owns cash, positions, source observations, and totals. PostgreSQL's statement
// snapshot prevents a completed execution from splitting these into different account versions.
async function valuation(c:Pool|PoolClient,userId:string):Promise<Valuation>{
  const row=(await c.query<Valuation>(`WITH account AS (
    SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1 AND u.active
  ), inputs AS (
    SELECT p.*,i.symbol,i.name,i.currency,i.paused,q.session,q.observed_at AS quote_time,
      CASE WHEN q.price>0 AND q.provider=i.provider AND (NOT $2::boolean OR i.provider<>'fixture')
        AND q.raw_currency=CASE WHEN i.multiplier=0.01 THEN 'GBp' ELSE i.currency END AND q.price=round(q.raw_price*i.multiplier,8)
        AND q.observed_at<=clock_timestamp()+interval '5 seconds' THEN q.price END AS price,
      CASE WHEN i.currency='INR' THEN 1 WHEN f.rate>0 AND f.provider=i.provider AND f.observed_at<=clock_timestamp()+interval '5 seconds' THEN f.rate END AS rate,
      CASE WHEN i.currency='INR' THEN q.observed_at ELSE f.observed_at END AS fx_time
    FROM account a JOIN positions p ON p.account_id=a.id JOIN instruments i ON i.id=p.instrument_id
    LEFT JOIN latest_quotes q ON q.instrument_id=i.id LEFT JOIN latest_fx_rates f ON f.currency=i.currency
  ), priced AS (
    SELECT *,CASE WHEN round(quantity*price*rate,2)<=99999999999999999999.99 THEN round(quantity*price*rate,2) END AS value FROM inputs
  ), valued AS (
    SELECT *,CASE WHEN value IS NULL THEN 'incomplete'  WHEN paused THEN 'review'
        WHEN quote_time<clock_timestamp()-interval '60 seconds' OR fx_time<clock_timestamp()-interval '24 hours'
          OR session IS DISTINCT FROM 'REGULAR' THEN 'stale' ELSE 'fresh' END AS quality
    FROM priced
  ), totals AS (
    SELECT COALESCE(sum(value),0) AS holdings,COALESCE(sum(value-base_cost),0) AS pl,
      CASE WHEN bool_or(quality='incomplete') OR abs(COALESCE(sum(value-base_cost),0))>99999999999999999999.99999999
        OR COALESCE(sum(value),0)>99999999999999999999999999.99-COALESCE((SELECT cash_balance FROM account),0) THEN 'incomplete' WHEN bool_or(quality='review') THEN 'review'
       WHEN bool_or(quality='stale') THEN 'stale' ELSE 'fresh' END AS quality,
      min(least(quote_time,fx_time)) AS observed_from,max(greatest(quote_time,fx_time)) AS observed_to
    FROM valued
  ) SELECT jsonb_build_object('account',jsonb_build_object('id',a.id,'baseCurrency',a.base_currency,'cashBalance',a.cash_balance::text,'cashSequence',a.cash_sequence::text),
    'positions',COALESCE((SELECT jsonb_agg(jsonb_build_object('instrumentId',instrument_id,'symbol',symbol,'name',name,'currency',currency,
      'quantity',quantity::text,'nativeCost',native_cost::text,'baseCost',base_cost::text,'price',price::numeric(20,8)::text,
      'value',value::numeric(28,2)::text,'unrealizedPl',(value-base_cost)::numeric(28,8)::text,'quality',quality,'observedAt',quote_time) ORDER BY symbol,instrument_id) FROM valued),'[]'::jsonb),
    'totalValue',CASE WHEN t.quality='incomplete' THEN NULL ELSE (a.cash_balance+t.holdings)::numeric(28,2)::text END,
    'holdingsValue',CASE WHEN t.quality='incomplete' THEN NULL ELSE t.holdings::numeric(28,2)::text END,
    'unrealizedPl',CASE WHEN t.quality='incomplete' THEN NULL ELSE t.pl::numeric(28,8)::text END,
    'quality',t.quality,'observedAt',t.observed_from) AS portfolio,t.observed_from::text,t.observed_to::text,statement_timestamp()::text AS sampled_at
    FROM account a CROSS JOIN totals t`,[userId,process.env.NODE_ENV==='production'])).rows[0];
  if(!row)throw new AppError(404,'ACCOUNT_NOT_FOUND','Account not found');return row;
}
export async function readPortfolio(pool:Pool,userId:string):Promise<PortfolioView>{return (await valuation(pool,userId)).portfolio;}
export async function sampleSnapshots(pool:Pool):Promise<void>{
  const accounts=(await pool.query<{user_id:string}>(`SELECT a.user_id FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.active AND
   (a.valuation_dirty OR NOT EXISTS(SELECT 1 FROM portfolio_snapshots s WHERE s.account_id=a.id AND s.sample_bucket=date_bin(interval '5 minutes',clock_timestamp(),timestamptz '2000-01-01')))
   ORDER BY a.valuation_checked_at,a.id LIMIT 100`)).rows;
  let incomplete=0;
  for(const account of accounts)await withTransaction(pool,async c=>{
    const {portfolio:p,observed_from,observed_to,sampled_at}=await valuation(c,account.user_id);
    if(p.quality==='incomplete'){incomplete++;await c.query('UPDATE accounts SET valuation_checked_at=clock_timestamp() WHERE id=$1',[p.account.id]);return;}
    await c.query(`INSERT INTO portfolio_snapshots(account_id,account_sequence,sample_bucket,sampled_at,cash_balance,holdings_value,total_value,unrealized_pl,quality,observed_from,observed_to)
      VALUES($1,$2,date_bin(interval '5 minutes',$10::timestamptz,timestamptz '2000-01-01'),$10::timestamptz,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(account_id,sample_bucket) DO UPDATE SET account_sequence=EXCLUDED.account_sequence,sampled_at=EXCLUDED.sampled_at,
      cash_balance=EXCLUDED.cash_balance,holdings_value=EXCLUDED.holdings_value,total_value=EXCLUDED.total_value,unrealized_pl=EXCLUDED.unrealized_pl,
      quality=EXCLUDED.quality,observed_from=EXCLUDED.observed_from,observed_to=EXCLUDED.observed_to
      WHERE portfolio_snapshots.account_sequence<EXCLUDED.account_sequence OR
        (portfolio_snapshots.account_sequence=EXCLUDED.account_sequence AND portfolio_snapshots.sampled_at<EXCLUDED.sampled_at)`,
      [p.account.id,p.account.cashSequence,p.account.cashBalance,p.holdingsValue,p.totalValue,p.unrealizedPl,p.quality,observed_from,observed_to,sampled_at]);
    // Trades after the valuation statement retain their dirty flag for a later sample.
    await c.query(`UPDATE accounts SET valuation_checked_at=clock_timestamp(),valuation_dirty=CASE WHEN cash_sequence=$2 THEN false ELSE valuation_dirty END WHERE id=$1`,[p.account.id,p.account.cashSequence]);
  });
  await pool.query(`INSERT INTO worker_status(id,incomplete_accounts) VALUES('main',$1) ON CONFLICT(id) DO UPDATE SET incomplete_accounts=$1`,[incomplete]);
}
