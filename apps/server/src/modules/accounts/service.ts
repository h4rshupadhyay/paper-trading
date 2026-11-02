import type { AccountView } from '@paper/contracts/foundation';
import type { Pool } from 'pg';
import { AppError } from '../../platform/errors.js';

export async function readAccount(pool: Pool, userId: string): Promise<AccountView> {
  const result = await pool.query<AccountView>(`SELECT a.id, a.base_currency AS "baseCurrency",
    a.cash_balance::text AS "cashBalance", a.cash_sequence::text AS "cashSequence"
    FROM accounts a JOIN users u ON u.id=a.user_id
    WHERE u.id=$1 AND u.active`, [userId]);
  const account = result.rows[0];
  if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  return account;
}
