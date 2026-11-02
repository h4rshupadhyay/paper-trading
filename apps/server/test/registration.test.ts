import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAccount } from '../src/modules/accounts/service.js';
import { parseRegisterInput } from '../src/modules/identity/input.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { AppError } from '../src/platform/errors.js';
import { migrate } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';

let harness: TestHarness;
beforeEach(async () => {
  harness = await createHarness();
  await migrate(harness.ownerPool);
});
afterEach(async () => { await harness.close(); });

const input = { username: 'alice', email: 'alice@example.com', password: '  secret password  ' };
const hashPassword = async () => 'stored-password-hash';
const emptyCounts = { users: 0, accounts: 0, cashMovements: 0, defaultFolders: 0 };
const completeCounts = { users: 1, accounts: 1, cashMovements: 1, defaultFolders: 1 };

async function countsForUser(userId: string | null = null) {
  const result = await harness.ownerPool.query(`SELECT
    (SELECT count(*)::integer FROM users WHERE $1::uuid IS NULL OR id=$1) AS users,
    (SELECT count(*)::integer FROM accounts WHERE $1::uuid IS NULL OR user_id=$1) AS accounts,
    (SELECT count(*)::integer FROM cash_movements m JOIN accounts a ON a.id=m.account_id
      WHERE $1::uuid IS NULL OR a.user_id=$1) AS "cashMovements",
    (SELECT count(*)::integer FROM watchlist_folders
      WHERE is_default AND ($1::uuid IS NULL OR user_id=$1)) AS "defaultFolders"`, [userId]);
  return result.rows[0];
}

// Missing any aggregate write, leaking secrets, or rounding money breaks these assertions.
describe('atomic registration', () => {
  it('hashes the unmodified password before checkout and returns only safe identity/account DTOs', async () => {
    const result = await registerUser(harness.appPool, input, async password => {
      expect(password).toBe('  secret password  ');
      expect(harness.appPool.totalCount).toBe(0);
      return 'stored-password-hash';
    });
    expect(result).toEqual({
      user: { id: expect.any(String), username: 'alice', email: 'alice@example.com' },
      account: { id: expect.any(String), baseCurrency: 'INR', cashBalance: '1000000.00', cashSequence: '1' },
    });
    expect(result.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.account.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await countsForUser(result.user.id)).toEqual(completeCounts);
    expect((await harness.ownerPool.query('SELECT password_hash FROM users WHERE id=$1', [result.user.id])).rows)
      .toEqual([{ password_hash: 'stored-password-hash' }]);
    expect((await harness.ownerPool.query('SELECT name,is_default FROM watchlist_folders WHERE user_id=$1', [result.user.id])).rows)
      .toEqual([{ name: 'Default', is_default: true }]);
    expect((await harness.ownerPool.query(`SELECT
      (a.cash_balance - sum(m.amount))::numeric(20,2)::text AS difference,
      min(m.reason) AS reason, min(m.account_sequence)::text AS sequence,
      min(m.resulting_balance)::text AS balance
      FROM accounts a JOIN cash_movements m ON m.account_id=a.id WHERE a.id=$1
      GROUP BY a.id`, [result.account.id])).rows)
      .toEqual([{ difference: '0.00', reason: 'OPENING_CREDIT', sequence: '1', balance: '1000000.00' }]);
    expect(harness.appPool.idleCount).toBe(harness.appPool.totalCount);
  });

  it('creates nothing and checks out no client if hashing fails, then permits another registration', async () => {
    const failure = new Error('hash unavailable');
    await expect(registerUser(harness.appPool, input, async () => { throw failure; })).rejects.toBe(failure);
    expect(harness.appPool.totalCount).toBe(0);
    expect(await countsForUser()).toEqual(emptyCounts);
    await registerUser(harness.appPool, input, hashPassword);
    expect(await countsForUser()).toEqual(completeCounts);
  });

  it.each([
    { username: 'alice', email: 'other@example.com' },
    { username: 'other', email: 'alice@example.com' },
  ])('maps a duplicate identity to the same safe 409: $username/$email', async duplicate => {
    await registerUser(harness.appPool, input, hashPassword);
    const failure = await registerUser(harness.appPool, { ...input, ...duplicate }, hashPassword).catch(error => error);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ status: 409, code: 'IDENTITY_CONFLICT', fields: undefined });
    expect(failure.message).not.toMatch(/alice|other|email|username|users_|SELECT|INSERT|hash/i);
    expect(await countsForUser()).toEqual(completeCounts);
    const next = await registerUser(harness.appPool,
      { ...input, username: 'next_user', email: 'next@example.com' }, hashPassword);
    expect(await countsForUser(next.user.id)).toEqual(completeCounts);
  });

  it.each(['users', 'accounts', 'cash_movements', 'watchlist_folders'])
    ('rolls back the whole aggregate after the %s insert fails and releases its client', async table => {
      // Names come only from the literal table list, never user input.
      await harness.ownerPool.query(`CREATE FUNCTION registration_fault() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test registration fault'; END; $$;
        CREATE TRIGGER registration_fault AFTER INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION registration_fault()`);
      await expect(registerUser(harness.appPool, input, hashPassword)).rejects.toMatchObject({ code: 'P0001' });
      expect(await countsForUser()).toEqual(emptyCounts);
      expect(harness.appPool.idleCount).toBe(harness.appPool.totalCount);
      await harness.ownerPool.query(`DROP TRIGGER registration_fault ON ${table}`);
      const next = await registerUser(harness.appPool, input, hashPassword);
      expect(await countsForUser(next.user.id)).toEqual(completeCounts);
    });

  it('does not disguise a non-identity unique violation as an identity conflict', async () => {
    await harness.ownerPool.query(`CREATE FUNCTION registration_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test non-identity collision'
        USING ERRCODE='23505', CONSTRAINT='cash_movements_one_opening'; END; $$;
      CREATE TRIGGER registration_fault AFTER INSERT ON cash_movements
      FOR EACH ROW EXECUTE FUNCTION registration_fault()`);
    const failure = await registerUser(harness.appPool, input, hashPassword).catch(error => error);
    expect(failure).not.toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: '23505', constraint: 'cash_movements_one_opening' });
    expect(await countsForUser()).toEqual(emptyCounts);
  });

  it('concurrent normalized duplicates leave exactly one complete aggregate', async () => {
    const first = parseRegisterInput({ ...input, username: ' Alice ', email: 'ALICE@example.com ' });
    const second = parseRegisterInput({ ...input, username: 'ALICE', email: ' alice@EXAMPLE.com' });
    let ready = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const concurrentHash = async () => {
      if (++ready === 2) release();
      await barrier;
      return 'stored-password-hash';
    };
    const outcomes = await Promise.allSettled([
      registerUser(harness.appPool, first, concurrentHash),
      registerUser(harness.appPool, second, concurrentHash),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(AppError);
    expect(rejected?.reason).toMatchObject({ status: 409, code: 'IDENTITY_CONFLICT' });
    expect(await countsForUser()).toEqual(completeCounts);
    expect(harness.appPool.totalCount).toBeGreaterThanOrEqual(2);
    expect(harness.appPool.idleCount).toBe(harness.appPool.totalCount);
  });
});

// Removing the active-user/ownership join or converting numbers to JS numbers fails these reads.
describe('owned account projection', () => {
  it('returns each active user’s own account and exact decimal/bigint strings', async () => {
    const first = await registerUser(harness.appPool, input, hashPassword);
    const second = await registerUser(harness.appPool,
      { ...input, username: 'bob', email: 'bob@example.com' }, hashPassword);
    await harness.ownerPool.query('UPDATE accounts SET cash_balance=$1,cash_sequence=$2 WHERE id=$3',
      ['999999999999999999.99', '9007199254740993', second.account.id]);
    expect(await readAccount(harness.appPool, first.user.id)).toEqual(first.account);
    expect(await readAccount(harness.appPool, second.user.id)).toEqual({
      id: second.account.id, baseCurrency: 'INR', cashBalance: '999999999999999999.99', cashSequence: '9007199254740993',
    });
  });

  it('returns the same safe 404 for absent, accountless and inactive users', async () => {
    const existing = await registerUser(harness.appPool, input, hashPassword);
    await harness.ownerPool.query('UPDATE users SET active=false WHERE id=$1', [existing.user.id]);
    const accountless = (await harness.ownerPool.query<{ id: string }>(
      "INSERT INTO users(username,email,password_hash) VALUES('no_account','none@example.com','hash') RETURNING id")).rows[0]!.id;
    for (const id of [randomUUID(), accountless, existing.user.id]) {
      await expect(readAccount(harness.appPool, id)).rejects.toMatchObject({
        status: 404, code: 'ACCOUNT_NOT_FOUND',
      });
    }
    // Supplying an existing account ID cannot bypass the user-ID scope.
    await expect(readAccount(harness.appPool, existing.account.id)).rejects.toMatchObject({
      status: 404, code: 'ACCOUNT_NOT_FOUND',
    });
  });
});
