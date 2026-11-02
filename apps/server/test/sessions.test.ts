import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../src/modules/identity/passwords.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { authenticate, csrfForSession, login, revokeSession, verifyCsrf } from '../src/modules/identity/sessions.js';
import { AppError } from '../src/platform/errors.js';
import { migrate } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';

let harness: TestHarness;
let passwordHash: string;
const input = { username: 'alice', email: 'alice@example.com', password: '  correct password  ' };
const secret = 'a separate CSRF secret of at least 32 bytes';
beforeAll(async () => { passwordHash = await hashPassword(input.password); });
beforeEach(async () => { harness = await createHarness(); await migrate(harness.ownerPool); });
afterEach(async () => { vi.restoreAllMocks(); await harness.close(); });

async function register(username = input.username) {
  return registerUser(harness.appPool, { ...input, username, email: `${username}@example.com` }, async () => passwordHash);
}
async function signIn(previousToken?: string) { return login(harness.appPool, input, secret, previousToken); }
async function sessionCount() {
  return (await harness.ownerPool.query('SELECT count(*)::integer AS count FROM sessions')).rows[0]!.count;
}

// Reducing cost, changing password bytes, or using deterministic salts breaks password verification.
describe('password hashing', () => {
  it('uses bcrypt cost 12 with independent salts and unmodified password bytes', async () => {
    const password = '  café secret password  ';
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(bcrypt.getRounds(first)).toBe(12);
    expect(first).not.toBe(second);
    expect(await bcrypt.compare(password, first)).toBe(true);
    expect(await bcrypt.compare(password.trim(), first)).toBe(false);
  });
});

// A fixed public vector catches signing the wrong message/secret; cross-session and malformed inputs fail closed.
describe('session-bound CSRF', () => {
  it('derives the HMAC-SHA-256 base64url token and binds it to both session and secret', () => {
    expect(csrfForSession('token', 'secret')).toBe('6UERDj0r_oJiHw4-FDRzDXMF0QbF9oyHFl0LJ6RhGko');
    const tokenA = randomBytes(32).toString('base64url');
    const tokenB = randomBytes(32).toString('base64url');
    const csrf = csrfForSession(tokenA, secret);
    expect(verifyCsrf(tokenA, csrf, secret)).toBe(true);
    expect(verifyCsrf(tokenA, csrfForSession(tokenB, secret), secret)).toBe(false);
    expect(verifyCsrf(tokenA, csrf, `${secret}!`)).toBe(false);
    for (const malformed of ['', 'a', 'a'.repeat(44), `${csrf}=`, '!'.repeat(43), `${csrf}\n`]) {
      expect(verifyCsrf(tokenA, malformed, secret)).toBe(false);
    }
  });
});

describe('revocable opaque sessions', () => {
  it('permits only safe active-user locking while runtime user updates remain forbidden', async () => {
    const { user } = await register();
    expect((await harness.appPool.query('SELECT * FROM public.lock_active_user($1)', [user.id])).rows).toEqual([user]);
    expect((await harness.appPool.query('SELECT * FROM public.lock_active_user($1)', [randomUUID()])).rows).toEqual([]);
    await expect(harness.appPool.query('UPDATE users SET active=false WHERE id=$1', [user.id]))
      .rejects.toMatchObject({ code: '42501' });
    await harness.ownerPool.query('UPDATE users SET active=false WHERE id=$1', [user.id]);
    expect((await harness.appPool.query('SELECT * FROM public.lock_active_user($1)', [user.id])).rows).toEqual([]);
    const capability = (await harness.ownerPool.query(`SELECT
      p.prosecdef AS definer, p.proconfig AS config,
      has_function_privilege('paper_app','public.lock_active_user(uuid)','EXECUTE') AS app_execute,
      EXISTS (SELECT FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p WHERE p.oid='public.lock_active_user(uuid)'::regprocedure`)).rows[0]!;
    expect(capability).toEqual({ definer: true, config: ['search_path=pg_catalog'], app_execute: true, public_execute: false });
  });

  it('stores only a SHA-256 digest, uses 32 random bytes, returns safe DTOs, and expires in exactly 24 database hours', async () => {
    const registered = await register();
    const first = await signIn();
    const second = await signIn();
    expect(first.user).toEqual(registered.user);
    expect(Object.keys(first)).toEqual(['user', 'session']);
    expect(Object.keys(first.session).sort()).toEqual(['csrfToken', 'expiresAt', 'token']);
    expect(first.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first.session.token, 'base64url')).toHaveLength(32);
    expect(second.session.token).not.toBe(first.session.token);
    expect(verifyCsrf(first.session.token, first.session.csrfToken, secret)).toBe(true);
    const stored = (await harness.ownerPool.query(`SELECT id,token_hash,expires_at,
      extract(epoch FROM expires_at-created_at)::integer AS lifetime FROM sessions WHERE token_hash=$1`,
    [createHash('sha256').update(first.session.token).digest('hex')])).rows[0]!;
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toBe(first.session.token);
    expect(stored.lifetime).toBe(86400);
    expect(first.session.expiresAt).toEqual(stored.expires_at);
    expect(await authenticate(harness.appPool, first.session.token)).toEqual({
      user: registered.user, accountId: registered.account.id, sessionId: stored.id,
    });
  });

  it('returns indistinguishable safe invalid-credential errors and performs dummy bcrypt verification for unknown users', async () => {
    await register();
    const compare = vi.spyOn(bcrypt, 'compare');
    const failures = [];
    for (const attempt of [{ ...input, password: 'wrong password' }, { ...input, username: 'unknown' }]) {
      failures.push(await login(harness.appPool, attempt, secret).catch(error => error));
    }
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid credentials', fields: undefined });
    }
    expect(compare).toHaveBeenCalledTimes(2);
    expect(bcrypt.getRounds(String(compare.mock.calls[1]![1]))).toBe(12);
    expect(await sessionCount()).toBe(0);
  });

  it('rejects an inactive identity without creating a session', async () => {
    const { user } = await register();
    await harness.ownerPool.query('UPDATE users SET active=false WHERE id=$1', [user.id]);
    await expect(signIn()).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    expect(await sessionCount()).toBe(0);
  });

  it('rejects malformed tokens before touching the database and well-formed forgeries with the same safe 401', async () => {
    for (const token of ['', 'a', 'a'.repeat(44), '!'.repeat(43), `${'a'.repeat(43)}=`, `${'a'.repeat(43)}\n`, 'A'.repeat(42) + 'B']) {
      const query = vi.spyOn(harness.appPool, 'query');
      await expect(authenticate(harness.appPool, token)).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
      expect(query).not.toHaveBeenCalled();
      query.mockRestore();
    }
    await expect(authenticate(harness.appPool, randomBytes(32).toString('base64url')))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED', message: 'Authentication required' });
  });

  it('revokes idempotently and leaves independent sessions working', async () => {
    await register();
    const first = await signIn();
    const second = await signIn();
    const principal = await authenticate(harness.appPool, first.session.token);
    await revokeSession(harness.appPool, principal.sessionId);
    const revokedAt = (await harness.ownerPool.query('SELECT revoked_at FROM sessions WHERE id=$1', [principal.sessionId])).rows[0]!.revoked_at;
    await revokeSession(harness.appPool, principal.sessionId);
    await revokeSession(harness.appPool, randomUUID());
    expect((await harness.ownerPool.query('SELECT revoked_at FROM sessions WHERE id=$1', [principal.sessionId])).rows[0]!.revoked_at).toEqual(revokedAt);
    await expect(authenticate(harness.appPool, first.session.token)).rejects.toMatchObject({ status: 401 });
    expect((await authenticate(harness.appPool, second.session.token)).user.username).toBe('alice');
  });

  it('checks active state on every authentication', async () => {
    const { user } = await register();
    const { session } = await signIn();
    await authenticate(harness.appPool, session.token);
    await harness.ownerPool.query('UPDATE users SET active=false WHERE id=$1', [user.id]);
    await expect(authenticate(harness.appPool, session.token)).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('rejects a session exactly at the database transaction clock expiry boundary', async () => {
    await register();
    const { session } = await signIn();
    // Sequential queries use the only connection in this owner pool, preserving PostgreSQL transaction time.
    await harness.ownerPool.query('BEGIN');
    try {
      await harness.ownerPool.query('UPDATE sessions SET expires_at=CURRENT_TIMESTAMP');
      expect((await harness.ownerPool.query('SELECT expires_at=CURRENT_TIMESTAMP AS boundary FROM sessions')).rows[0]!.boundary).toBe(true);
      await expect(authenticate(harness.ownerPool, session.token)).rejects.toMatchObject({ status: 401 });
    } finally { await harness.ownerPool.query('ROLLBACK'); }
  });

  it('rejects past sessions using database time even when the application clock is wrong', async () => {
    await register();
    const { session } = await signIn();
    await harness.ownerPool.query("UPDATE sessions SET expires_at=CURRENT_TIMESTAMP-interval '1 second'");
    vi.spyOn(Date, 'now').mockReturnValue(0);
    await expect(authenticate(harness.appPool, session.token)).rejects.toMatchObject({ status: 401 });
  });

  it('rotates only the supplied session and permits invalid previous tokens without revoking another session', async () => {
    await register();
    const old = await signIn();
    const independent = await signIn();
    const replacement = await signIn(old.session.token);
    await expect(authenticate(harness.appPool, old.session.token)).rejects.toMatchObject({ status: 401 });
    await authenticate(harness.appPool, independent.session.token);
    await authenticate(harness.appPool, replacement.session.token);
    for (const previous of ['malformed', randomBytes(32).toString('base64url')]) {
      await authenticate(harness.appPool, (await signIn(previous)).session.token);
    }
    await authenticate(harness.appPool, independent.session.token);
  });

  it('rolls back previous-session revocation if session insertion fails and releases the client', async () => {
    await register();
    const old = await signIn();
    await harness.ownerPool.query(`CREATE FUNCTION session_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test session insertion fault'; END; $$;
      CREATE TRIGGER session_fault AFTER INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION session_fault()`);
    const failure = await signIn(old.session.token).catch(error => error);
    expect(failure).not.toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: 'P0001' });
    expect(await sessionCount()).toBe(1);
    await authenticate(harness.appPool, old.session.token);
    expect(harness.appPool.idleCount).toBe(harness.appPool.totalCount);
  });

  it('rechecks a user deactivated after password verification while waiting for the user lock', async () => {
    const { user } = await register();
    const blocker = await harness.ownerPool.connect();
    let result: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      result = signIn().catch(error => error);
      await vi.waitFor(async () => {
        // Non-superuser owners cannot read another role's pg_stat_activity wait details.
        const waiting = await harness.ownerPool.query(`SELECT count(*)::integer AS count FROM pg_locks l
          JOIN pg_stat_activity a USING(pid)
          WHERE a.datname=current_database() AND a.usename='paper_app' AND NOT l.granted`);
        expect(waiting.rows[0]!.count).toBeGreaterThan(0);
      }, { timeout: 5000, interval: 20 });
      await blocker.query('UPDATE users SET active=false WHERE id=$1', [user.id]);
      await blocker.query('COMMIT');
      expect(await result).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
      expect(await sessionCount()).toBe(0);
      expect(harness.appPool.idleCount).toBe(harness.appPool.totalCount);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await result; }
  });

  it('keeps database failures distinct from invalid authentication', async () => {
    await register();
    const { session } = await signIn();
    const { sessionId } = await authenticate(harness.appPool, session.token);
    await harness.ownerPool.query('DROP TABLE sessions');
    for (const operation of [() => authenticate(harness.appPool, session.token), () => signIn(), () => revokeSession(harness.appPool, sessionId)]) {
      const failure = await operation().catch(error => error);
      expect(failure).not.toBeInstanceOf(AppError);
      expect(failure).toMatchObject({ code: '42P01' });
    }
  });
});
