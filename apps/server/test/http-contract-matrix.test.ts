import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { csrfForSession } from '../src/modules/identity/sessions.js';
import { loadConfig } from '../src/platform/config.js';
import { createSafeLogger } from '../src/platform/logging.js';
import { migrate } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';

// All routes are exercised through the complete middleware stack. Fixtures are
// confined by createHarness to its guarded, disposable PostgreSQL instance.
const origin = 'https://paper.example';
const id = '11111111-1111-4111-8111-111111111111';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://app:password@127.0.0.1:55439/unused', PUBLIC_ORIGIN: origin, CSRF_SECRET: 'matrix csrf secret with at least 32 bytes' });
type Method = 'get' | 'post' | 'patch' | 'delete';
const reads = [
  '/auth/me', '/auth/csrf', '/account', '/account/reconciliation',
  '/orders', `/orders/${id}`, '/executions', '/portfolio', '/portfolio/snapshots',
  '/watchlists', '/watchlists/folders', '/watchlists/entries', '/notes', `/notes/${id}`,
  '/alerts', '/notifications', '/instruments', `/instruments/${id}`,
  `/instruments/${id}/quote`, `/instruments/${id}/statistics`,
  `/instruments/${id}/snapshot`, `/instruments/${id}/history`, '/fx-rates',
];
const writes: [Method, string][] = [
  ['post', '/auth/logout'], ['post', '/orders'], ['post', `/orders/${id}/cancel`],
  ['post', '/watchlists/folders'], ['patch', `/watchlists/folders/${id}`], ['delete', `/watchlists/folders/${id}`],
  ['post', '/watchlists/entries'], ['patch', `/watchlists/entries/${id}`], ['delete', `/watchlists/entries/${id}`],
  ['post', '/notes'], ['patch', `/notes/${id}`], ['delete', `/notes/${id}`],
  ['post', '/alerts'], ['delete', `/alerts/${id}`], ['post', '/notifications/read'],
];
let harness: TestHarness;
let app: ReturnType<typeof createApp>;
let cookie: string;
let csrf: string;
beforeAll(async () => {
  harness = await createHarness(); await migrate(harness.ownerPool);
  const { user } = await registerUser(harness.appPool, { username: 'matrix', email: 'matrix@example.com', password: 'matrix password 123' }, async () => 'fixture-hash');
  const token = randomBytes(32).toString('base64url');
  await harness.ownerPool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [user.id, createHash('sha256').update(token).digest('hex')]);
  cookie = `paper_session=${token}`; csrf = csrfForSession(token, config.csrfSecret);
  app = createApp({ pool: harness.appPool, config, logger: createSafeLogger(() => {}) });
});
afterAll(async () => { if (harness) await harness.close(); });

function safeError(response: request.Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.body.error).toMatchObject({ code, message: expect.any(String), requestId: expect.any(String) });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['x-request-id']).toBe(response.body.error.requestId);
  expect(response.text).not.toMatch(/password|fixture-hash|SELECT |INSERT |stack|node_modules/i);
}
function authenticated(method: Method, path: string) {
  return request(app)[method](`/api${path}`).set('Origin', origin).set('Cookie', cookie).set('X-CSRF-Token', csrf);
}

describe('HTTP-MATRIX endpoint guard coverage', () => {
  it.each(reads)('rejects anonymous GET %s', async path => {
    safeError(await request(app).get(`/api${path}`), 401, 'UNAUTHENTICATED');
  });
  it.each(writes)('rejects anonymous %s %s', async (method, path) => {
    safeError(await request(app)[method](`/api${path}`).set('Origin', origin).send({}), 401, 'UNAUTHENTICATED');
  });
  it.each(writes)('rejects missing Origin on %s %s', async (method, path) => {
    safeError(await request(app)[method](`/api${path}`).set('Cookie', cookie).set('X-CSRF-Token', csrf).send({}), 403, 'ORIGIN_FORBIDDEN');
  });
  it.each(writes)('rejects cross-origin %s %s before any mutation', async (method, path) => {
    safeError(await request(app)[method](`/api${path}`).set('Origin', 'https://evil.example').set('Cookie', cookie).set('X-CSRF-Token', csrf).send({}), 403, 'ORIGIN_FORBIDDEN');
  });
  it.each(writes)('rejects missing CSRF on %s %s', async (method, path) => {
    safeError(await request(app)[method](`/api${path}`).set('Origin', origin).set('Cookie', cookie).send({}), 403, 'CSRF_INVALID');
  });
  it.each(writes)('rejects forged CSRF on %s %s', async (method, path) => {
    safeError(await request(app)[method](`/api${path}`).set('Origin', origin).set('Cookie', cookie).set('X-CSRF-Token', 'x'.repeat(43)).send({}), 403, 'CSRF_INVALID');
  });
});

const invalidQueries = [
  '/account?userId=x', '/account/reconciliation?accountId=x', '/portfolio?userId=x',
  '/orders?limit=0', '/orders?limit=101', '/orders?limit=01', '/orders?limit=1&limit=2',
  '/orders?status=COMPLETE', '/orders?cursor=not-uuid', '/executions?limit=-1',
  '/executions?cursor=not-uuid', '/portfolio/snapshots?days=0', '/portfolio/snapshots?days=1826',
  '/portfolio/snapshots?days=1.5', '/portfolio/snapshots?days=1&days=2', '/portfolio/snapshots?cursor=bad',
  '/watchlists?userId=x', '/watchlists/folders?limit=101', '/watchlists/folders?cursor=bad',
  '/watchlists/entries?folderId=bad', '/notes?cursor=bad', '/notes?limit=0',
  '/alerts?limit=101', '/notifications?unread=1', '/notifications?unread=true&unread=false',
  '/instruments?q=x&q=y', '/instruments?q=' + 'x'.repeat(81), '/instruments?q=%00',
  '/instruments?userId=x', `/instruments/${id}/history?period=2y`,
  `/instruments/${id}/history?interval=1m`, `/instruments/${id}/history?period=1d&period=5d`,
  `/instruments/${id}/quote?price=1`, `/instruments/${id}/statistics?refresh=true`,
  `/instruments/${id}/snapshot?userId=x`, '/fx-rates?currency=ZZZ',
];
const invalidBodies: [Method, string, object][] = [
  ['post', '/watchlists/folders', { name: '' }], ['post', '/watchlists/folders', { name: 'x'.repeat(81) }],
  ['post', '/watchlists/folders', { name: 'bad\nname' }], ['post', '/watchlists/folders', { name: 'Fine', userId: id }],
  ['post', '/watchlists/entries', { instrumentId: 'bad' }], ['post', '/watchlists/entries', { instrumentId: id, folderId: 'bad' }],
  ['patch', `/watchlists/entries/${id}`, {}], ['post', '/notes', { title: '', body: '' }],
  ['post', '/notes', { title: 'x'.repeat(201), body: '' }], ['post', '/notes', { title: 'Fine', body: 'x'.repeat(10001) }],
  ['post', '/notes', { title: 'Fine', body: '\u0000' }], ['post', '/notes', { title: 'Fine', body: '', userId: id }],
  ['patch', `/notes/${id}`, {}], ['post', '/alerts', { instrumentId: id, condition: 'EQUAL', targetPrice: '1' }],
  ['post', '/alerts', { instrumentId: id, condition: 'ABOVE', targetPrice: '0' }],
  ['post', '/alerts', { instrumentId: id, condition: 'BELOW', targetPrice: '-1' }],
  ['post', '/alerts', { instrumentId: id, condition: 'ABOVE', targetPrice: '1e2' }],
  ['post', '/alerts', { instrumentId: id, condition: 'ABOVE', targetPrice: '1.123456789' }],
  ['post', '/notifications/read', { ids: [] }], ['post', '/notifications/read', { ids: [id, id] }],
  ['post', '/notifications/read', { ids: Array.from({ length: 101 }, () => id) }],
  ['post', `/orders/${id}/cancel`, { status: 'FILLED' }],
];
describe('HTTP-MATRIX malformed inputs and side effects', () => {
  it.each(invalidQueries)('validates query GET %s', async path => {
    safeError(await authenticated('get', path), 400, 'VALIDATION_ERROR');
  });
  it.each(invalidBodies)('validates %s %s body %#', async (method, path, body) => {
    safeError(await authenticated(method, path).send(body), 400, 'VALIDATION_ERROR');
  });
  it('leaves the seeded account and owned collections unchanged after denied requests', async () => {
    for (const table of ['orders', 'executions', 'positions', 'watchlist_entries', 'notes', 'price_alerts', 'notifications']) {
      expect((await harness.ownerPool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]!.count).toBe(0);
    }
    expect((await harness.ownerPool.query('SELECT cash_balance::text, cash_sequence::text FROM accounts')).rows).toEqual([{ cash_balance: '1000000.00', cash_sequence: '1' }]);
    expect((await harness.ownerPool.query('SELECT count(*)::int AS count FROM cash_movements')).rows[0]!.count).toBe(1);
    expect((await authenticated('get', '/auth/me')).status).toBe(200);
  });
});
