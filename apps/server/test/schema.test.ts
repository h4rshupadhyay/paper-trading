import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { migrate, readSchemaVersion } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';

let harness: TestHarness;
beforeEach(async () => { harness = await createHarness(); });
afterEach(async () => { await harness.close(); });

async function user(pool = harness.appPool): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO users (id, username, email, password_hash) VALUES ($1,$2,$3,$4)',
    [id, `u_${id.replaceAll('-', '').slice(0, 20)}`, `${id}@example.com`, 'hash']);
  return id;
}
async function account(userId: string, balance = '1000000.00', sequence = '1', currency = 'INR'): Promise<string> {
  const id = randomUUID();
  await harness.appPool.query('INSERT INTO accounts (id,user_id,base_currency,cash_balance,cash_sequence) VALUES ($1,$2,$3,$4,$5)',
    [id, userId, currency, balance, sequence]);
  return id;
}
async function opening(accountId: string, sequence = '1', amount = '1000000.00', balance = '1000000.00', reason = 'OPENING_CREDIT') {
  return harness.appPool.query('INSERT INTO cash_movements (id,account_id,account_sequence,amount,resulting_balance,reason) VALUES ($1,$2,$3,$4,$5,$6)',
    [randomUUID(), accountId, sequence, amount, balance, reason]);
}

// These tests detect missing locking/version reads, non-atomic DDL, or leaked clients.
describe('versioned migrations', () => {
  it('reads an unmigrated database without changing it, then applies version 1 exactly once', async () => {
    expect(await readSchemaVersion(harness.appPool)).toBe(0);
    await migrate(harness.ownerPool, 1);
    const id = await user();
    await migrate(harness.ownerPool, 1);
    expect(await readSchemaVersion(harness.appPool)).toBe(1);
    expect((await harness.appPool.query('SELECT id FROM users')).rows).toEqual([{ id }]);
    expect((await harness.ownerPool.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: 1 }]);
  });

  it('serializes concurrent migration calls on dedicated connections', async () => {
    await Promise.all([migrate(harness.ownerPool, 1), migrate(harness.ownerPool, 1)]);
    expect(await Promise.all([readSchemaVersion(harness.ownerPool), readSchemaVersion(harness.appPool)])).toEqual([1, 1]);
    expect(harness.ownerPool.idleCount).toBe(harness.ownerPool.totalCount);
  });

  it('rolls back all DDL and the version on failure, releases the lock and permits retry', async () => {
    await harness.ownerPool.query('CREATE TABLE sessions (probe integer)');
    await expect(migrate(harness.ownerPool, 1)).rejects.toMatchObject({ code: '42P07' });
    expect((await harness.ownerPool.query("SELECT to_regclass('schema_migrations') AS versions, to_regclass('accounts') AS accounts, to_regclass('users') AS users, to_regclass('watchlist_folders') AS folders")).rows)
      .toEqual([{ versions: null, accounts: null, users: null, folders: null }]);
    expect(await readSchemaVersion(harness.ownerPool)).toBe(0);
    await harness.ownerPool.query('DROP TABLE sessions');
    await migrate(harness.ownerPool, 1);
    expect(await readSchemaVersion(harness.appPool)).toBe(1);
    expect(harness.ownerPool.idleCount).toBe(harness.ownerPool.totalCount);
  });

  it('fails with a nonzero CLI exit on migration errors without logging credentials', async () => {
    await harness.ownerPool.query('CREATE TABLE users (probe integer)');
    const database = (await harness.ownerPool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!.name;
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/platform/migrate.ts'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env,
        MIGRATION_DATABASE_URL: `postgresql://paper_owner:paper_owner_test_only@127.0.0.1:55439/${database}` },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('paper_owner_test_only');
    expect(await readSchemaVersion(harness.ownerPool)).toBe(0);
  });
});

// Removing SQL constraints/grants would admit the invalid writes below.
describe('foundation constraints and runtime privileges', () => {
  beforeEach(async () => { await migrate(harness.ownerPool, 1); });

  it.each([
    ['NaN', '23514'], ['-0.01', '23514'], ['1000000000000000000.00', '22003'],
    ['Infinity', '22003'], ['-Infinity', '22003'],
  ])('rejects non-finite/out-of-range cash %s', async (balance, code) => {
    await expect(account(await user(), balance)).rejects.toMatchObject({ code });
  });

  it('accepts exact cash bounds and preserves decimal and bigint strings', async () => {
    await account(await user(), '0.00');
    const id = await account(await user(), '999999999999999999.99', '9007199254740993');
    expect((await harness.appPool.query('SELECT cash_balance,cash_sequence,base_currency,valuation_dirty FROM accounts WHERE id=$1', [id])).rows)
      .toEqual([{ cash_balance: '999999999999999999.99', cash_sequence: '9007199254740993', base_currency: 'INR', valuation_dirty: false }]);
  });

  it('enforces one account per user, INR currency, positive sequence and existing owner', async () => {
    const id = await user(); await account(id);
    await expect(account(id)).rejects.toMatchObject({ code: '23505' });
    await expect(account(await user(), '0.00', '0')).rejects.toMatchObject({ code: '23514' });
    await expect(account(await user(), '0.00', '-1')).rejects.toMatchObject({ code: '23514' });
    await expect(account(await user(), '0.00', '1', 'USD')).rejects.toMatchObject({ code: '23514' });
    await expect(account(randomUUID())).rejects.toMatchObject({ code: '23503' });
  });

  it('requires normalized unique usernames and emails', async () => {
    const values = ['alice', 'alice@example.com', 'hash'];
    await harness.appPool.query('INSERT INTO users(username,email,password_hash) VALUES($1,$2,$3)', values);
    await expect(harness.appPool.query("INSERT INTO users(username,email,password_hash) VALUES('alice','other@example.com','hash')")).rejects.toMatchObject({ code: '23505' });
    await expect(harness.appPool.query("INSERT INTO users(username,email,password_hash) VALUES('other','alice@example.com','hash')")).rejects.toMatchObject({ code: '23505' });
    for (const [username, email] of [[' Alice ', 'other@example.com'], ['bob', 'BOB@example.com'], ['bob', ' bob@example.com ']]) {
      await expect(harness.appPool.query('INSERT INTO users(username,email,password_hash) VALUES($1,$2,$3)', [username, email, 'hash'])).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('allows only a single matching opening credit and unique account sequence', async () => {
    const id = await account(await user());
    await opening(id);
    await expect(opening(id)).rejects.toMatchObject({ code: '23505' });
    // Owner-only fixture temporarily permits later reasons/sequences so each
    // independent uniqueness boundary can be exercised by runtime writes.
    await harness.ownerPool.query('ALTER TABLE cash_movements DROP CONSTRAINT opening_credit_only');
    await expect(opening(id, '2')).rejects.toMatchObject({ code: '23505' });
    await expect(opening(id, '1', '1.00', '1000001.00', 'TRADE')).rejects.toMatchObject({ code: '23505' });
  });

  it.each([
    ['0', '1000000.00', '1000000.00', 'OPENING_CREDIT'],
    ['2', '1000000.00', '1000000.00', 'OPENING_CREDIT'],
    ['1', '1.00', '1000000.00', 'OPENING_CREDIT'],
    ['1', '1000000.00', '0.00', 'OPENING_CREDIT'],
    ['1', 'NaN', '1000000.00', 'OPENING_CREDIT'],
    ['1', '1000000.00', 'NaN', 'OPENING_CREDIT'],
    ['1', '1000000.00', '1000000.00', 'TRADE'],
  ])('rejects invalid opening settlement %#', async (sequence, amount, balance, reason) => {
    await expect(opening(await account(await user()), sequence, amount, balance, reason)).rejects.toMatchObject({ code: '23514' });
  });

  it('denies ledger mutation, identity/account deletion and DDL to runtime', async () => {
    const userId = await user(); const accountId = await account(userId); await opening(accountId);
    for (const query of ["UPDATE cash_movements SET amount=1", 'DELETE FROM cash_movements', 'TRUNCATE cash_movements',
      'DELETE FROM accounts', 'DELETE FROM users', 'DROP TABLE users', 'CREATE TABLE forbidden(id int)',
      'UPDATE schema_migrations SET version=2']) {
      await expect(harness.appPool.query(query)).rejects.toMatchObject({ code: '42501' });
    }
    const owners = (await harness.ownerPool.query<{ owner: string }>("SELECT tableowner AS owner FROM pg_tables WHERE schemaname='public'")).rows;
    expect(owners.length).toBe(6); expect(owners.every(row => row.owner === 'paper_owner')).toBe(true);
  });

  it('protects the default folder and enforces owner/name and one-default uniqueness', async () => {
    const userId = await user(); const other = await user();
    const folderId = randomUUID();
    await harness.appPool.query("INSERT INTO watchlist_folders(id,user_id,name,is_default) VALUES($1,$2,'Default',true)", [folderId, userId]);
    await expect(harness.appPool.query('DELETE FROM watchlist_folders WHERE id=$1', [folderId])).rejects.toMatchObject({ code: '23514' });
    await expect(harness.ownerPool.query('UPDATE watchlist_folders SET user_id=$1 WHERE id=$2', [other, folderId])).rejects.toMatchObject({ code: '23514' });
    await expect(harness.ownerPool.query('UPDATE watchlist_folders SET is_default=false WHERE id=$1', [folderId])).rejects.toMatchObject({ code: '23514' });
    await expect(harness.appPool.query("INSERT INTO watchlist_folders(user_id,name,is_default) VALUES($1,'Other',true)", [userId])).rejects.toMatchObject({ code: '23505' });
    await expect(harness.appPool.query("INSERT INTO watchlist_folders(user_id,name) VALUES($1,'Default')", [userId])).rejects.toMatchObject({ code: '23505' });
    await harness.appPool.query("INSERT INTO watchlist_folders(user_id,name,is_default) VALUES($1,'Default',true)", [other]);
    // A real composite FK probe proves the ownership key is usable by later tables.
    await harness.ownerPool.query('CREATE TABLE folder_probe(user_id uuid, folder_id uuid, FOREIGN KEY(user_id,folder_id) REFERENCES watchlist_folders(user_id,id))');
    await expect(harness.ownerPool.query('INSERT INTO folder_probe VALUES($1,$2)', [other, folderId])).rejects.toMatchObject({ code: '23503' });
  });

  it('stores only unique 64-character SHA-256 hex session hashes and permits revocation', async () => {
    const userId = await user();
    for (const hash of ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
      await expect(harness.appPool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day')", [userId, hash])).rejects.toMatchObject({ code: '23514' });
    }
    await harness.appPool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day')", [userId, 'a'.repeat(64)]);
    await expect(harness.appPool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day')", [userId, 'a'.repeat(64)])).rejects.toMatchObject({ code: '23505' });
    await harness.appPool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [userId]);
    expect((await harness.appPool.query('SELECT revoked_at IS NOT NULL AS revoked FROM sessions')).rows).toEqual([{ revoked: true }]);
  });
});
