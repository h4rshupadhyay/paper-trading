import type { Pool } from 'pg';
import { AppError } from '../../platform/errors.js';

const ranges = {
  '1d': { range: '1 day', stride: '5 minutes', interval: '5m', unit: null },
  '5d': { range: '5 days', stride: '15 minutes', interval: '15m', unit: null },
  '1mo': { range: '1 month', stride: '1 day', interval: '1d', unit: 'day' },
  '3mo': { range: '3 months', stride: '1 day', interval: '1d', unit: 'day' },
  '6mo': { range: '6 months', stride: '1 day', interval: '1d', unit: 'day' },
  '1y': { range: '1 year', stride: '1 week', interval: '1wk', unit: 'week' },
  '5y': { range: '5 years', stride: '1 month', interval: '1mo', unit: 'month' },
} as const;
export type PortfolioPeriod = keyof typeof ranges;

export async function readPortfolioHistory(pool: Pool, userId: string, query: Record<string, unknown>) {
  const period = query.period ?? '5y';
  if (Object.keys(query).some(key => key !== 'period') || typeof period !== 'string' || !Object.hasOwn(ranges, period)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid portfolio history range');
  }
  const selection = ranges[period as PortfolioPeriod];
  // Generate a fixed, small set of buckets, then use the account/time index to
  // seek each final real sample. Do not load five years of raw snapshots.
  const result = await pool.query<{totalValue:string}>(`
    WITH bounds AS (
      SELECT (timezone('UTC',now())-$2::interval) AT TIME ZONE 'UTC' AS lo,now() AS hi
    ), owner AS (SELECT id FROM accounts WHERE user_id=$1),
    buckets AS (
      SELECT t AT TIME ZONE 'UTC' AS t FROM bounds, LATERAL generate_series(
        (CASE WHEN $4::text IS NULL THEN date_bin($3::interval,lo,'2000-01-01'::timestamptz)
          ELSE date_trunc($4::text,lo,'UTC') END) AT TIME ZONE 'UTC',hi AT TIME ZONE 'UTC',$3::interval) t
      LIMIT 1498
    ), chosen AS (
      SELECT s.* FROM buckets CROSS JOIN bounds CROSS JOIN owner
      CROSS JOIN LATERAL (
        SELECT s.* FROM portfolio_snapshots s WHERE s.account_id=owner.id
          AND s.sampled_at>=greatest(t,lo) AND s.sampled_at< (timezone('UTC',t)+$3::interval) AT TIME ZONE 'UTC' AND s.sampled_at<=hi
        ORDER BY s.sampled_at DESC,s.id DESC LIMIT 1
      ) s
      UNION
      (SELECT s.* FROM portfolio_snapshots s JOIN owner ON owner.id=s.account_id CROSS JOIN bounds
        WHERE s.sampled_at>=lo AND s.sampled_at<=hi ORDER BY s.sampled_at,s.id LIMIT 1)
      UNION
      (SELECT s.* FROM portfolio_snapshots s JOIN owner ON owner.id=s.account_id CROSS JOIN bounds
        WHERE s.sampled_at>=lo AND s.sampled_at<=hi ORDER BY s.sampled_at DESC,s.id DESC LIMIT 1)
    ) SELECT id,account_sequence::text AS "accountSequence",sampled_at AS "sampledAt",
      cash_balance::text AS "cashBalance",holdings_value::text AS "holdingsValue",total_value::text AS "totalValue",
      unrealized_pl::text AS "unrealizedPl",quality,observed_from AS "observedFrom",observed_to AS "observedTo"
    FROM chosen ORDER BY sampled_at,id LIMIT 1500`, [userId,selection.range,selection.stride,selection.unit]);
  return { items: result.rows, period, interval: selection.interval,
    firstValue: result.rows[0]?.totalValue ?? null, lastValue: result.rows.at(-1)?.totalValue ?? null };
}
