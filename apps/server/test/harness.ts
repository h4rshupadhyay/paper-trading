import { randomUUID } from 'node:crypto';
import pg, { type Pool } from 'pg';
import { createPool } from '../src/platform/db.js';

export type TestHarness = { ownerPool: Pool; appPool: Pool; close(): Promise<void> };
const ownerPassword = 'paper_owner_test_only';
const appPassword = 'paper_app_test_only';

export async function createHarness(): Promise<TestHarness> {
  let url: URL;
  try { url = new URL(process.env.TEST_DATABASE_ADMIN_URL ?? ''); }
  catch { throw new Error('An isolated test database admin URL is required'); }
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '55439'
    || url.pathname !== '/paper_foundation_test_admin' || url.username !== 'paper_test_admin'
    || url.password !== 'paper_test_admin_only' || url.search || url.hash) {
    throw new Error('Refusing database outside the isolated test instance');
  }
  const admin = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  const database = `paper_test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  const makePool = (role: string, password: string): Pool => {
    const connection = new URL(url);
    connection.pathname = `/${database}`; connection.username = role; connection.password = password;
    return createPool(connection.href);
  };
  try {
    const client = await admin.connect();
    try {
      await client.query('SELECT pg_advisory_lock(1480963201)');
      try {
        await client.query(`DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'paper_owner') THEN
            CREATE ROLE paper_owner LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
          END IF;
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'paper_app') THEN
            CREATE ROLE paper_app LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
          END IF;
        END $$`);
        await client.query(`CREATE DATABASE "${database}" OWNER paper_owner`);
        created = true;
      } finally { await client.query('SELECT pg_advisory_unlock(1480963201)'); }
    } finally { client.release(); }
    const ownerPool = makePool('paper_owner', ownerPassword);
    const appPool = makePool('paper_app', appPassword);
    let closed = false;
    return { ownerPool, appPool, async close() {
      if (closed) return;
      closed = true;
      try {
        await Promise.all([ownerPool.end(), appPool.end()]);
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      } finally { await admin.end(); }
    } };
  } catch (error) {
    try { if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); }
    finally { await admin.end(); }
    throw error;
  }
}
