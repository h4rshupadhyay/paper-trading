import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/platform/config.js';
import { createPool, withTransaction } from '../src/platform/db.js';
import { AppError } from '../src/platform/errors.js';
import { createHarness, type TestHarness } from './harness.js';

const validEnv = {
  NODE_ENV: 'test', PORT: '3001', DATABASE_URL: 'postgresql://paper_app:secret@127.0.0.1:55439/paper_test_example',
  PUBLIC_ORIGIN: 'http://localhost:5173', CSRF_SECRET: 'a'.repeat(32),
};
let harness: TestHarness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

describe('runtime configuration', () => {
  // Missing validation would permit unsafe startup or implicit database credentials.
  it.each([
    { NODE_ENV: 'production' },
    { ...validEnv, NODE_ENV: 'unknown' },
    { ...validEnv, DATABASE_URL: '' },
    { ...validEnv, DATABASE_URL: 'postgresql://127.0.0.1/paper' },
    { ...validEnv, DATABASE_URL: 'postgresql://paper_app@127.0.0.1/paper' },
    { ...validEnv, DATABASE_URL: 'postgresql://paper_app:secret@127.0.0.1/' },
    { ...validEnv, DATABASE_URL: 'postgresql://paper_app:secret@127.0.0.1/paper?password=' },
    { ...validEnv, DATABASE_URL: 'https://paper_app:secret@127.0.0.1/paper' },
    { ...validEnv, PORT: '0' }, { ...validEnv, PORT: '65536' },
    { ...validEnv, PORT: '3000oops' }, { ...validEnv, PORT: '1.5' },
    { ...validEnv, PUBLIC_ORIGIN: '*' }, { ...validEnv, PUBLIC_ORIGIN: 'null' },
    { ...validEnv, PUBLIC_ORIGIN: 'https://example.com/path' },
    { ...validEnv, PUBLIC_ORIGIN: 'https://user:secret@example.com' },
    { ...validEnv, CSRF_SECRET: 'a'.repeat(31) }, { ...validEnv, CSRF_SECRET: '' },
  ])('rejects invalid startup configuration %#', env => { expect(() => loadConfig(env)).toThrow(); });

  it('returns only runtime configuration with a byte-counted secret', () => {
    expect(loadConfig({ ...validEnv, CSRF_SECRET: 'é'.repeat(16), MIGRATION_DATABASE_URL: 'must-not-escape' })).toEqual({
      nodeEnv: 'test', port: 3001, databaseUrl: validEnv.DATABASE_URL, expectedSchemaVersion: 6,
      publicOrigin: 'http://localhost:5173', csrfSecret: 'é'.repeat(16),
    });
  });

  it('does not expose credentials in configuration errors', () => {
    const secret = 'credential-must-not-leak';
    try { loadConfig({ ...validEnv, DATABASE_URL: `https://paper_app:${secret}@localhost/paper` }); }
    catch (error) { expect(String(error)).not.toContain(secret); return; }
    throw new Error('Expected configuration rejection');
  });
});

describe('PostgreSQL platform', () => {
  it('rolls back failed work and permits a subsequent committed transaction', async () => {
    harness = await createHarness();
    const pool = harness.ownerPool;
    await pool.query('CREATE TABLE probe (value integer NOT NULL)');
    const observer = await pool.connect();
    try {
      await expect(withTransaction(pool, async client => {
        await client.query('INSERT INTO probe VALUES (1)');
        throw new Error('fault');
      })).rejects.toThrow('fault');
      expect((await observer.query('SELECT * FROM probe')).rows).toEqual([]);
      const result = await withTransaction(pool, async client => {
        await client.query('INSERT INTO probe VALUES (2)');
        return 'committed';
      });
      expect(result).toBe('committed');
      expect((await observer.query('SELECT * FROM probe')).rows).toEqual([{ value: 2 }]);
    } finally { observer.release(); }
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
  });

  it('uses separate restricted roles and makes the owner own each fresh database', async () => {
    harness = await createHarness();
    expect((await harness.ownerPool.query('SELECT current_user AS name')).rows).toEqual([{ name: 'paper_owner' }]);
    expect((await harness.appPool.query('SELECT current_user AS name')).rows).toEqual([{ name: 'paper_app' }]);
    expect((await harness.ownerPool.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()')).rows).toEqual([{ owner: 'paper_owner' }]);
    await expect(harness.appPool.query('CREATE TABLE forbidden (id integer)')).rejects.toThrow(/permission denied/);
  });

  it('keeps financial decimals and large sequences as strings', async () => {
    harness = await createHarness();
    expect((await harness.appPool.query("SELECT 1000000.00::numeric(20,2) AS cash, 9007199254740993::bigint AS sequence")).rows)
      .toEqual([{ cash: '1000000.00', sequence: '9007199254740993' }]);
  });

  it('bounds query time without leaving the connection unusable', async () => {
    harness = await createHarness();
    const client = await harness.appPool.connect();
    try {
      const timeout = await client.query('SHOW statement_timeout');
      expect(timeout.rows[0]?.statement_timeout).toBe('5s');
      await expect(client.query('SELECT pg_sleep(6)')).rejects.toThrow(/statement timeout/);
      expect((await client.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }]);
    } finally { client.release(); }
  });

  it('rejects accidental non-test admin connections before connecting', async () => {
    const original = process.env.TEST_DATABASE_ADMIN_URL;
    try {
      process.env.TEST_DATABASE_ADMIN_URL = 'postgresql://admin:secret@production.example.com/live';
      await expect(createHarness()).rejects.toThrow(/isolated test/);
    } finally { process.env.TEST_DATABASE_ADMIN_URL = original; }
  });

  it('exposes a bounded pool with an explicit connection URL', async () => {
    const pool = createPool(validEnv.DATABASE_URL);
    try { expect(pool.options.max).toBeGreaterThan(0); expect(pool.options.max).toBeLessThanOrEqual(10); }
    finally { await pool.end(); }
  });

  it('enforces timeouts even when connection URL parameters request unbounded queries', async () => {
    harness = await createHarness();
    const database = (await harness.ownerPool.query<{ database: string }>('SELECT current_database() AS database')).rows[0]!.database;
    const pool = createPool(`postgresql://paper_app:paper_app_test_only@127.0.0.1:55439/${database}?statement_timeout=0&query_timeout=0&idle_in_transaction_session_timeout=0`);
    try {
      expect((await pool.query('SHOW statement_timeout')).rows).toEqual([{ statement_timeout: '5s' }]);
      expect((await pool.query('SHOW idle_in_transaction_session_timeout')).rows).toEqual([{ idle_in_transaction_session_timeout: '10s' }]);
    } finally { await pool.end(); }
  });
});

it('carries safe application error metadata', () => {
  const error = new AppError(422, 'INVALID_INPUT', 'Invalid input', { username: 'Invalid username' });
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ status: 422, code: 'INVALID_INPUT', message: 'Invalid input', fields: { username: 'Invalid username' } });
});
