import type { AccountView, PublicUser, RegisterInput, RegistrationResult } from '@paper/contracts/foundation';
import type { Pool } from 'pg';
import { withTransaction } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';

export async function registerUser(
  pool: Pool,
  input: RegisterInput,
  hashPassword: (password: string) => Promise<string>,
): Promise<RegistrationResult> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await withTransaction(pool, async client => {
      const user = (await client.query<PublicUser>(`INSERT INTO users(username,email,password_hash)
        VALUES($1,$2,$3) RETURNING id,username,email`, [input.username, input.email, passwordHash])).rows[0]!;
      const account = (await client.query<AccountView>(`INSERT INTO accounts(user_id,base_currency,cash_balance,cash_sequence)
        VALUES($1,'INR',1000000.00,1) RETURNING id,base_currency AS "baseCurrency",
        cash_balance::text AS "cashBalance",cash_sequence::text AS "cashSequence"`, [user.id])).rows[0]!;
      await client.query(`INSERT INTO cash_movements(account_id,account_sequence,amount,resulting_balance,reason)
        VALUES($1,1,1000000.00,1000000.00,'OPENING_CREDIT')`, [account.id]);
      await client.query(`INSERT INTO watchlist_folders(user_id,name,is_default) VALUES($1,'Default',true)`, [user.id]);
      return { user, account };
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
      && 'constraint' in error && (error.constraint === 'users_username_key' || error.constraint === 'users_email_key')) {
      throw new AppError(409, 'IDENTITY_CONFLICT', 'Identity unavailable');
    }
    throw error;
  }
}
