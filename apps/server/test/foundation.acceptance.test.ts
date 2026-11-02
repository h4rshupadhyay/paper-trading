import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { RegistrationResult } from '@paper/contracts/foundation';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type TestHarness } from './harness.js';

const serverRoot = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://127.0.0.1:4173';
const secret = 'acceptance-test-only-csrf-secret-at-least-32-bytes';
let harness: TestHarness;
let api: Awaited<ReturnType<typeof startCompiledApi>> | undefined;

beforeEach(async () => { harness = await createHarness(); });
afterEach(async () => {
  try { await api?.stop(); }
  finally { api = undefined; await harness.close(); }
});

function databaseUrl(pool: Pool): string {
  const options = pool.options;
  const url = new URL('postgresql://127.0.0.1:55439/');
  url.username = String(options.user);
  url.password = String(options.password);
  url.pathname = `/${options.database}`;
  return url.href;
}

function migrateWithCli() {
  const result = spawnSync(process.execPath, ['dist/src/platform/migrate.js'], {
    cwd: serverRoot, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl(harness.ownerPool) },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).not.toContain(String(harness.ownerPool.options.password));
  return result;
}

async function startCompiledApi() {
  expect(existsSync(`${serverRoot}dist/src/api.js`),
    'Compiled API is missing; the integration command must build from a clean checkout').toBe(true);
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing acceptance port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, ['dist/src/api.js'], {
    cwd: serverRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: databaseUrl(harness.appPool),
      PUBLIC_ORIGIN: origin, CSRF_SECRET: secret },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('exit', resolve);
  });
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) { await exited; return; }
    const fallback = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.kill('SIGTERM');
    try {
      expect(await exited).toBe(0);
      expect(output).toContain('api_stopped');
      for (const value of [secret, String(harness.appPool.options.password)]) expect(output).not.toContain(value);
    } finally { clearTimeout(fallback); }
  }
  try {
    await vi.waitFor(() => {
      expect(child.exitCode, 'Compiled API exited before listening').toBeNull();
      expect(output).toContain('api_listening');
    }, { timeout: 5000 });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    throw error;
  }
  return { stop, request(path: string, init: RequestInit = {}) {
    return fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: AbortSignal.timeout(3000) });
  } };
}

async function persistedAggregate(userId: string) {
  return (await harness.appPool.query(`SELECT a.id AS "accountId", a.cash_balance AS balance,
    a.cash_sequence AS sequence,
    (SELECT count(*)::integer FROM cash_movements c WHERE c.account_id=a.id AND c.reason='OPENING_CREDIT') AS "openingCount",
    (SELECT count(*)::integer FROM watchlist_folders w WHERE w.user_id=a.user_id AND w.is_default) AS "defaultFolderCount"
    FROM accounts a WHERE a.user_id=$1`, [userId])).rows;
}

describe('compiled foundation lifecycle', () => {
  // Startup DDL/demo seeding, lost session persistence, cash reset or forgotten
  // revocation after restart all violate this independently observed lifecycle.
  it('requires explicit migration and preserves the account and session through API restarts, including logout', async () => {
    api = await startCompiledApi();
    expect((await api.request('/api/health/live')).status).toBe(200);
    expect((await api.request('/api/health/ready')).status).toBe(503);
    expect((await harness.ownerPool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([]);

    expect(migrateWithCli().status).toBe(0);
    expect((await api.request('/api/health/ready')).status).toBe(200);
    expect((await harness.appPool.query(`SELECT
      (SELECT count(*)::integer FROM users) AS users,
      (SELECT count(*)::integer FROM accounts) AS accounts,
      (SELECT count(*)::integer FROM cash_movements) AS movements,
      (SELECT count(*)::integer FROM watchlist_folders) AS folders,
      (SELECT count(*)::integer FROM sessions) AS sessions`)).rows)
      .toEqual([{ users: 0, accounts: 0, movements: 0, folders: 0, sessions: 0 }]);

    const input = { username: 'durable_user', email: 'durable@example.com', password: 'a durable test password' };
    const registered = await api.request('/api/auth/register', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    expect(registered.status).toBe(201);
    expect(registered.headers.get('set-cookie')).toBeNull();
    const registration = await registered.json() as RegistrationResult;
    const expected = [{ accountId: registration.account.id, balance: '1000000.00', sequence: '1', openingCount: 1, defaultFolderCount: 1 }];
    expect(registration.account).toEqual({ id: registration.account.id, baseCurrency: 'INR', cashBalance: '1000000.00', cashSequence: '1' });
    expect(await persistedAggregate(registration.user.id)).toEqual(expected);
    const loggedIn = await api.request('/api/auth/login', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: input.username, password: input.password }) });
    expect(loggedIn.status).toBe(200);
    expect(await loggedIn.json()).toEqual({ user: registration.user });
    const cookie = loggedIn.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toMatch(/^paper_session=[A-Za-z0-9_-]{43}$/);
    const headers = { Cookie: cookie! };

    await api.stop();
    api = await startCompiledApi(); // Same database and unchanged cookie/IDs; no migration or re-login.
    expect((await api.request('/api/health/ready')).status).toBe(200);
    const me = await api.request('/api/auth/me', { headers });
    expect(me.status).toBe(200); expect(await me.json()).toEqual({ user: registration.user });
    const account = await api.request('/api/account', { headers });
    expect(account.status).toBe(200); expect(await account.json()).toEqual({ account: registration.account });
    expect(await persistedAggregate(registration.user.id)).toEqual(expected);
    const csrf = await api.request('/api/auth/csrf', { headers });
    expect(csrf.status).toBe(200);
    const { csrfToken } = await csrf.json() as { csrfToken: string };
    const loggedOut = await api.request('/api/auth/logout', {
      method: 'POST', headers: { ...headers, Origin: origin, 'X-CSRF-Token': csrfToken },
    });
    expect(loggedOut.status).toBe(204);
    expect(loggedOut.headers.get('set-cookie')).toContain('paper_session=;');

    await api.stop();
    api = await startCompiledApi();
    for (const path of ['/api/auth/me', '/api/auth/csrf', '/api/account']) {
      const revoked = await api.request(path, { headers });
      expect(revoked.status).toBe(401);
      expect(await revoked.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    }
    expect(await persistedAggregate(registration.user.id)).toEqual(expected);
    expect((await harness.ownerPool.query('SELECT revoked_at IS NOT NULL AS revoked FROM sessions')).rows).toEqual([{ revoked: true }]);
  });

  // A future schema must fail closed instead of being silently downgraded.
  it('refuses a newer database schema through the migration CLI without losing its version or data', async () => {
    expect(migrateWithCli().status).toBe(0);
    const witness = (await harness.appPool.query(`INSERT INTO users(username,email,password_hash)
      VALUES('future_user','future@example.com','test-only-witness') RETURNING id,username,email,password_hash`)).rows;
    await harness.ownerPool.query('UPDATE schema_migrations SET version=2');
    const refused = migrateWithCli();
    expect(refused.status).toBe(1);
    expect(refused.stderr.trim()).toBe('Database migration failed');
    expect((await harness.ownerPool.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: 2 }]);
    expect((await harness.appPool.query('SELECT id,username,email,password_hash FROM users')).rows).toEqual(witness);
  });
});
