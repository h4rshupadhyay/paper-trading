import type {Pool} from 'pg';
import {AppError} from '../../platform/errors.js';
export type Reconciliation={cashDifference:string;positionMismatchCount:number;executionMismatchCount:number;ledgerMismatchCount:number;sequenceMatches:boolean;balanced:boolean};
// An independent read compares maintained projections against immutable accounting records.
// All observations share this SQL statement's MVCC snapshot.
export async function reconcileAccount(pool:Pick<Pool,'query'>,userId:string):Promise<Reconciliation>{
 const result=(await pool.query<Reconciliation>(`WITH account AS (
  SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1 AND u.active
 ), running AS (
  SELECT m.*,sum(m.amount) OVER (PARTITION BY m.account_id ORDER BY m.account_sequence) AS expected_balance
  FROM account a JOIN cash_movements m ON m.account_id=a.id
 ), ledger_errors AS (SELECT count(*)::int AS n FROM running WHERE resulting_balance<>expected_balance), ledger AS (
  SELECT COALESCE(sum(m.amount),0) AS balance,count(m.id) AS count,max(m.account_sequence) AS last
  FROM account a LEFT JOIN cash_movements m ON m.account_id=a.id
 ), effects AS (
  SELECT e.instrument_id,CASE WHEN e.side='BUY' THEN e.quantity ELSE -e.quantity END quantity,
    CASE WHEN e.side='BUY' THEN e.native_amount ELSE -e.allocated_native_cost END native_cost,
    CASE WHEN e.side='BUY' THEN e.settlement ELSE -e.allocated_base_cost END base_cost,e.created_at at,2 priority
  FROM account a JOIN executions e ON e.account_id=a.id
  UNION ALL SELECT x.instrument_id,x.quantity_delta,0,0,x.effective_at,CASE WHEN x.kind='SPLIT' THEN 0 ELSE 1 END
  FROM account a JOIN account_actions x ON x.account_id=a.id
 ), expected AS (
  SELECT instrument_id,sum(quantity) quantity,sum(native_cost) native_cost,sum(base_cost) base_cost FROM effects GROUP BY instrument_id
 ), actual AS (SELECT p.* FROM account a JOIN positions p ON p.account_id=a.id),
 mismatches AS (
  SELECT count(*)::int AS n FROM expected e FULL JOIN actual p ON p.instrument_id=e.instrument_id
  WHERE COALESCE(e.quantity,0)<>COALESCE(p.quantity,0) OR COALESCE(e.native_cost,0)<>COALESCE(p.native_cost,0)
   OR COALESCE(e.base_cost,0)<>COALESCE(p.base_cost,0)
 ), settlements AS (
  SELECT count(*)::int AS n FROM account a JOIN executions e ON e.account_id=a.id
  LEFT JOIN cash_movements m ON m.execution_id=e.id
  WHERE m.id IS NULL OR m.account_id<>a.id OR m.reason<>e.side
   OR m.amount<>CASE WHEN e.side='BUY' THEN -e.settlement ELSE e.settlement END
 ), action_errors AS (
  SELECT count(*)::int n FROM account a JOIN account_actions x ON x.account_id=a.id LEFT JOIN cash_movements m ON m.action_id=x.id
  WHERE x.quantity_before<>COALESCE((SELECT sum(e.quantity) FROM effects e WHERE e.instrument_id=x.instrument_id AND (e.at,e.priority)<(x.effective_at,CASE WHEN x.kind='SPLIT' THEN 0 ELSE 1 END)),0)
   OR x.fx_observed_at>x.effective_at
   OR (x.kind='SPLIT' AND (x.quantity_delta<>x.quantity_before*(x.factor-1) OR m.id IS NOT NULL))
   OR (x.kind='DIVIDEND' AND (x.native_amount<>round(x.quantity_before*x.per_share,8) OR x.base_amount<>round(x.native_amount*x.fx_rate,2)
     OR m.id IS NULL OR m.account_id<>a.id OR m.reason<>'DIVIDEND' OR m.amount<>x.base_amount OR m.created_at<>x.effective_at))
 ) SELECT (a.cash_balance-l.balance)::numeric(20,2)::text AS "cashDifference",p.n AS "positionMismatchCount",(s.n+ae.n) AS "executionMismatchCount",le.n AS "ledgerMismatchCount",
  a.cash_sequence=l.last AND a.cash_sequence=l.count AS "sequenceMatches",
  a.cash_balance=l.balance AND a.cash_sequence=l.last AND a.cash_sequence=l.count AND p.n=0 AND s.n=0 AND ae.n=0 AND le.n=0 AS balanced
 FROM account a CROSS JOIN ledger l CROSS JOIN mismatches p CROSS JOIN settlements s CROSS JOIN ledger_errors le CROSS JOIN action_errors ae`,[userId])).rows[0];
 if(!result)throw new AppError(404,'ACCOUNT_NOT_FOUND','Account not found');return result;
}
