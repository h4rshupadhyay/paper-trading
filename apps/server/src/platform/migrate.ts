import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createPool } from './db.js';

const migrationLock = 1480963202;
const latestVersion = 1;

async function foundationSql(): Promise<string> {
  try { return await readFile(new URL('../../migrations/001_foundation.sql', import.meta.url), 'utf8'); }
  catch (error) {
    // tsc preserves src/platform beneath dist; SQL remains in the server root.
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    return readFile(new URL('../../../migrations/001_foundation.sql', import.meta.url), 'utf8');
  }
}

export async function readSchemaVersion(pool: Pool): Promise<number> {
  const exists = await pool.query<{ name: string | null }>("SELECT to_regclass('public.schema_migrations') AS name");
  if (!exists.rows[0]!.name) return 0;
  const result = await pool.query<{ version: number }>('SELECT COALESCE(MAX(version), 0) AS version FROM public.schema_migrations');
  return result.rows[0]!.version;
}

export async function migrate(pool: Pool): Promise<void> {
  // A pool.query lock could be acquired and released on different sessions.
  // Hold one client and a transaction-scoped advisory lock through all DDL.
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [migrationLock]);
    await client.query('SET LOCAL search_path = public, pg_catalog');
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version integer PRIMARY KEY CHECK (version > 0),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const result = await client.query<{ version: number }>('SELECT COALESCE(MAX(version), 0) AS version FROM public.schema_migrations');
    const version = result.rows[0]!.version;
    if (version > latestVersion) throw new Error('Database schema is newer than this migration runner');
    if (version === 0) {
      await client.query(await foundationSql());
      await client.query('INSERT INTO public.schema_migrations(version) VALUES ($1)', [latestVersion]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}

async function main(): Promise<void> {
  let pool: Pool | undefined;
  try {
    const raw = process.env.MIGRATION_DATABASE_URL;
    if (!raw) throw new Error('Missing migration database URL');
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username
      || !url.password || url.pathname.length < 2 || url.hash
      || ['user', 'password', 'host', 'port', 'database', 'dbname'].some(key => url.searchParams.has(key))) {
      throw new Error('Invalid migration database URL');
    }
    pool = createPool(raw);
    await migrate(pool);
  } catch {
    // Connection errors can contain credentials; deployment output stays bounded.
    console.error('Database migration failed');
    process.exitCode = 1;
  } finally { await pool?.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
