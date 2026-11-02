import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IssuedSession, LoginInput, Principal, PublicUser } from '@paper/contracts/foundation';
import bcrypt from 'bcrypt';
import type { Pool } from 'pg';
import { withTransaction } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';

// A fixed cost-12 hash makes unknown identities perform the same password work.
const dummyPasswordHash = '$2b$12$C3qO1K9OTmUb8r/OAiJ0ouGa/BsnBqoFibW85cTUlhybv2Mc79ndy';

function decodeToken(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === value ? decoded : undefined;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function csrfForSession(token: string, csrfSecret: string): string {
  return createHmac('sha256', csrfSecret).update(token).digest('base64url');
}

export function verifyCsrf(token: string, presented: string, csrfSecret: string): boolean {
  const decoded = decodeToken(presented);
  if (!decoded) return false;
  const expected = Buffer.from(csrfForSession(token, csrfSecret), 'base64url');
  return timingSafeEqual(decoded, expected);
}

export async function login(
  pool: Pool,
  input: LoginInput,
  csrfSecret: string,
  previousToken?: string,
): Promise<{ user: PublicUser; session: IssuedSession }> {
  const candidate = (await pool.query<{ id: string; password_hash: string; active: boolean }>(
    'SELECT id,password_hash,active FROM users WHERE username=$1', [input.username],
  )).rows[0];
  const verified = await bcrypt.compare(input.password, candidate?.password_hash ?? dummyPasswordHash);
  if (!candidate || !verified || !candidate.active) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  }

  return withTransaction(pool, async client => {
    // This narrow owner-defined capability locks without granting runtime user updates.
    const user = (await client.query<PublicUser>('SELECT * FROM public.lock_active_user($1)', [candidate.id])).rows[0];
    if (!user) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');

    if (previousToken && decodeToken(previousToken)) {
      await client.query(`UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP
        WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP
        AND EXISTS (SELECT 1 FROM users WHERE users.id=sessions.user_id AND users.active)`, [tokenHash(previousToken)]);
    }
    const token = randomBytes(32).toString('base64url');
    const row = (await client.query<{ expiresAt: Date }>(`INSERT INTO sessions(user_id,token_hash,expires_at)
      VALUES($1,$2,CURRENT_TIMESTAMP+interval '24 hours') RETURNING expires_at AS "expiresAt"`,
    [user.id, tokenHash(token)])).rows[0]!;
    return { user, session: { token, csrfToken: csrfForSession(token, csrfSecret), expiresAt: row.expiresAt } };
  });
}

export async function authenticate(pool: Pool, token: string): Promise<Principal> {
  if (decodeToken(token)) {
    const row = (await pool.query<PublicUser & { accountId: string; sessionId: string }>(`SELECT
      u.id,u.username,u.email,a.id AS "accountId",s.id AS "sessionId"
      FROM sessions s JOIN users u ON u.id=s.user_id JOIN accounts a ON a.user_id=u.id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP AND u.active`,
    [tokenHash(token)])).rows[0];
    if (row) {
      const { accountId, sessionId, ...user } = row;
      return { user, accountId, sessionId };
    }
  }
  throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
}

export async function revokeSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1 AND revoked_at IS NULL', [sessionId]);
}
