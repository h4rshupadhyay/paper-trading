import { createHash, randomBytes, randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerUser } from '../src/modules/identity/registration.js';
import { csrfForSession } from '../src/modules/identity/sessions.js';
import { toolsRoutes } from '../src/modules/user-tools/http.js';
import { evaluateAlerts } from '../src/modules/user-tools/service.js';
import { loadConfig } from '../src/platform/config.js';
import { enforceOrigin, errorHandler, requestContext } from '../src/platform/http.js';
import { createSafeLogger } from '../src/platform/logging.js';
import { migrate } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';

const origin = 'https://paper.example';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://app:password@127.0.0.1:55439/unused', PUBLIC_ORIGIN: origin, CSRF_SECRET: 'tools csrf secret with at least 32 bytes' });
let harness: TestHarness;
let app: express.Express;
type Owner = { id: string; cookie: string; csrf: string };
let alice: Owner;
let bob: Owner;
let instrumentId: string;

async function owner(username: string): Promise<Owner> {
  const { user } = await registerUser(harness.appPool, { username, email: `${username}@example.com`, password: 'correct password 123' }, async () => 'test-hash');
  const token = randomBytes(32).toString('base64url');
  await harness.ownerPool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')", [user.id, createHash('sha256').update(token).digest('hex')]);
  return { id: user.id, cookie: `paper_session=${token}`, csrf: csrfForSession(token, config.csrfSecret) };
}
function get(path: string, user = alice) { return request(app).get(`/api${path}`).set('Cookie', user.cookie); }
function mutate(method: 'post' | 'patch' | 'delete', path: string, body: object = {}, user = alice) {
  return request(app)[method](`/api${path}`).set('Origin', origin).set('Cookie', user.cookie).set('X-CSRF-Token', user.csrf).send(body);
}
async function folder(name = 'Research', user = alice) {
  const response = await mutate('post', '/watchlists/folders', { name }, user);
  expect(response.status).toBe(201); return response.body.folder as { id: string; name: string; isDefault: boolean };
}
async function quote(price: string, age = '0 seconds', session = 'REGULAR') {
  await harness.ownerPool.query(`INSERT INTO latest_quotes(instrument_id,price,observed_at,fetched_at,session,raw_currency,raw_price,action_key,provider)
    VALUES($1,$2,now()-$3::interval,now(),$4,'INR',$2,'fixture-v1','fixture') ON CONFLICT(instrument_id)
    DO UPDATE SET price=EXCLUDED.price,observed_at=EXCLUDED.observed_at,fetched_at=EXCLUDED.fetched_at,session=EXCLUDED.session`, [instrumentId, price, age, session]);
}
beforeEach(async () => {
  harness = await createHarness(); await migrate(harness.ownerPool, 3);
  const logger = createSafeLogger(() => {});
  app = express(); app.use(requestContext(logger), enforceOrigin(config), express.json({ limit: '16kb' }), cookieParser());
  app.use('/api', toolsRoutes({ pool: harness.appPool, config, logger })); app.use(errorHandler(logger));
  alice = await owner('alice'); bob = await owner('bobby');
  instrumentId = (await harness.ownerPool.query(`INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,paused,provider)
    VALUES('FIX.IN','Fixture','NSE','INR',1,'EQUITY',true,false,'fixture') RETURNING id`)).rows[0]!.id;
});
afterEach(async () => { if (harness) await harness.close(); });

describe('owned tools HTTP and SQL', () => {
  it('creates, renames, moves and deletes watchlist resources with atomic default deduplication', async () => {
    const initial = await get('/watchlists');
    expect(initial.status).toBe(200); expect(initial.body.items).toEqual([]);
    const defaultFolder = initial.body.folders[0]; expect(defaultFolder).toMatchObject({ name: 'Default', isDefault: true });
    const research = await folder();
    expect((await mutate('patch', `/watchlists/folders/${research.id}`, { name: 'Long term' })).body.folder.name).toBe('Long term');
    const first = await mutate('post', '/watchlists/entries', { instrumentId });
    expect(first.status).toBe(201); expect(first.body.entry).toMatchObject({ folderId: defaultFolder.id, instrumentId, symbol: 'FIX.IN', price: null, quality: 'UNAVAILABLE' });
    const second = await mutate('post', '/watchlists/entries', { instrumentId, folderId: research.id });
    expect(second.status).toBe(201);
    expect((await mutate('post', '/watchlists/entries', { instrumentId, folderId: research.id })).status).toBe(409);
    expect((await mutate('patch', `/watchlists/entries/${second.body.entry.id}`, { folderId: defaultFolder.id })).status).toBe(409);
    expect((await mutate('delete', `/watchlists/folders/${research.id}`)).status).toBe(204);
    expect((await get('/watchlists')).body.items).toHaveLength(1);
    expect((await mutate('delete', `/watchlists/folders/${defaultFolder.id}`)).status).toBe(409);
    expect((await mutate('patch', `/watchlists/folders/${defaultFolder.id}`, { isDefault: false })).status).toBe(400);
    const moveTo = await folder('Move');
    expect((await mutate('patch', `/watchlists/entries/${first.body.entry.id}`, { folderId: moveTo.id })).body.entry.folderId).toBe(moveTo.id);
    await quote('101.12345678');
    expect((await get('/watchlists/entries')).body.items[0]).toMatchObject({ price: '101.12345678', quality: 'FRESH' });
    expect((await mutate('delete', `/watchlists/folders/${moveTo.id}`)).status).toBe(204);
    const moved = (await get('/watchlists')).body.items[0]; expect(moved.folderId).toBe(defaultFolder.id);
    expect((await mutate('delete', `/watchlists/entries/${moved.id}`)).status).toBe(204);
    expect((await get('/watchlists/entries')).body).toEqual({ items: [], nextCursor: null });
  });

  it('scopes every resource and verifies the composite folder ownership constraint', async () => {
    const otherFolder = await folder('Other', bob);
    const foreign = await mutate('post', '/watchlists/entries', { instrumentId, folderId: otherFolder.id }, bob);
    expect((await mutate('post', '/watchlists/entries', { instrumentId, folderId: otherFolder.id })).status).toBe(404);
    for (const method of ['patch', 'delete'] as const) {
      expect((await mutate(method, `/watchlists/folders/${otherFolder.id}`, { name: 'Stolen' })).status).toBe(404);
      expect((await mutate(method, `/watchlists/entries/${foreign.body.entry.id}`, { folderId: otherFolder.id })).status).toBe(404);
    }
    expect((await get(`/watchlists/entries?folderId=${otherFolder.id}`)).status).toBe(404);
    const emptyForeignFolder = await folder('Empty other', bob);
    await expect(harness.appPool.query('INSERT INTO watchlist_entries(user_id,folder_id,instrument_id) VALUES($1,$2,$3)', [alice.id, emptyForeignFolder.id, instrumentId])).rejects.toMatchObject({ code: '23503' });
    const note = (await mutate('post', '/notes', { title: 'Private', body: 'secret' }, bob)).body.note;
    const alert = (await mutate('post', '/alerts', { instrumentId, condition: 'ABOVE', targetPrice: '100' }, bob)).body.alert;
    expect((await get('/notes')).body.items).toEqual([]); expect((await get('/alerts')).body.items).toEqual([]);
    expect((await get(`/notes/${note.id}`)).status).toBe(404);
    expect((await mutate('patch', `/notes/${note.id}`, { title: 'Stolen' })).status).toBe(404);
    expect((await mutate('delete', `/notes/${note.id}`)).status).toBe(404);
    expect((await mutate('delete', `/alerts/${alert.id}`)).status).toBe(404);
    await quote('100'); await evaluateAlerts(harness.appPool);
    const notification = (await get('/notifications', bob)).body.items[0];
    expect((await get('/notifications')).body.items).toEqual([]);
    expect((await mutate('post', '/notifications/read', { ids: [notification.id] })).status).toBe(404);
    expect((await get('/notifications', bob)).body.items[0].readAt).toBeNull();
  });

  it('supports note CRUD, explicit instrument removal and bounded stable cursor lists', async () => {
    const created = await mutate('post', '/notes', { title: 'Thesis', body: 'First line\nSecond line', instrumentId });
    expect(created.status).toBe(201);
    const note = created.body.note; expect(note).toMatchObject({ title: 'Thesis', body: 'First line\nSecond line', instrumentId, symbol: 'FIX.IN', createdAt: expect.any(String), updatedAt: expect.any(String) });
    expect((await get(`/notes/${note.id}`)).body.note).toEqual(note);
    expect((await mutate('patch', `/notes/${note.id}`, { body: 'Revised', instrumentId: null })).body.note).toMatchObject({ title: 'Thesis', body: 'Revised', instrumentId: null, symbol: null });
    for (const title of ['Second', 'Third']) expect((await mutate('post', '/notes', { title, body: '' })).status).toBe(201);
    const firstPage = (await get('/notes?limit=2')).body; expect(firstPage.items).toHaveLength(2); expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = (await get(`/notes?limit=2&cursor=${firstPage.nextCursor}`)).body;
    expect(secondPage.items).toHaveLength(1); expect(secondPage.nextCursor).toBeNull();
    expect(new Set([...firstPage.items, ...secondPage.items].map((item: { id: string }) => item.id)).size).toBe(3);
    expect((await mutate('delete', `/notes/${note.id}`)).status).toBe(204); expect((await get(`/notes/${note.id}`)).status).toBe(404);
  });

  it('evaluates exact inclusive thresholds once across competing workers and marks owned notifications read', async () => {
    await quote('100.00000001');
    const above = await mutate('post', '/alerts', { instrumentId, condition: 'ABOVE', targetPrice: '100.00000001' });
    expect(above.status).toBe(201); expect(above.body.alert).toMatchObject({ targetPrice: '100.00000001', active: true, triggeredAt: null, currency: 'INR' });
    const below = await mutate('post', '/alerts', { instrumentId, condition: 'BELOW', targetPrice: '100.00000000' });
    await Promise.all(Array.from({ length: 8 }, () => evaluateAlerts(harness.appPool)));
    let notifications = (await get('/notifications')).body.items;
    expect(notifications).toHaveLength(1); expect(notifications[0]).toMatchObject({ message: expect.stringContaining('FIX.IN'), readAt: null, createdAt: expect.any(String) });
    const alerts = (await get('/alerts')).body.items;
    expect(alerts.find((item: { id: string }) => item.id === above.body.alert.id)).toMatchObject({ active: false, triggeredAt: expect.any(String) });
    expect(alerts.find((item: { id: string }) => item.id === below.body.alert.id)).toMatchObject({ active: true, triggeredAt: null });
    expect((await mutate('post', '/notifications/read', { ids: [notifications[0].id, randomUUID()] })).status).toBe(404);
    expect((await get('/notifications')).body.items[0].readAt).toBeNull();
    const read = await mutate('post', '/notifications/read', { ids: [notifications[0].id] }); expect(read.status).toBe(200);
    notifications = (await get('/notifications')).body.items; expect(notifications[0].readAt).toEqual(expect.any(String));
    expect((await mutate('post', '/notifications/read', { ids: [notifications[0].id] })).body.items[0].readAt).toBe(notifications[0].readAt);
    expect((await get('/notifications?unread=true')).body.items).toEqual([]);
    expect((await get('/notifications?unread=false')).body.items).toHaveLength(1);
    await quote('100.00000000'); await evaluateAlerts(harness.appPool);
    expect((await get('/notifications?unread=true')).body.items).toHaveLength(1);
    expect((await mutate('delete', `/alerts/${above.body.alert.id}`)).status).toBe(204);
    expect((await get('/notifications')).body.items).toHaveLength(2);
    expect((await mutate('delete', `/alerts/${below.body.alert.id}`)).status).toBe(204);
  });

  it('serializes default insertion against folder deletion and rolls back every move on a deletion fault', async () => {
    const research = await folder();
    await mutate('post', '/watchlists/entries', { instrumentId, folderId: research.id });
    const outcomes = await Promise.all([mutate('post', '/watchlists/entries', { instrumentId }), mutate('delete', `/watchlists/folders/${research.id}`)]);
    expect([201, 409]).toContain(outcomes[0]!.status); expect(outcomes[1]!.status).toBe(204);
    const watchlist = (await get('/watchlists')).body;
    expect(watchlist.items).toHaveLength(1); expect(watchlist.items[0].folderId).toBe(watchlist.folders.find((item: { isDefault: boolean }) => item.isDefault).id);
    const other = await folder('Rollback');
    await mutate('patch', `/watchlists/entries/${watchlist.items[0].id}`, { folderId: other.id });
    await harness.ownerPool.query(`CREATE FUNCTION tools_folder_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test folder rollback'; END; $$;
      CREATE TRIGGER tools_folder_fault AFTER DELETE ON watchlist_folders FOR EACH ROW EXECUTE FUNCTION tools_folder_fault()`);
    expect((await mutate('delete', `/watchlists/folders/${other.id}`)).status).toBe(500);
    expect((await get('/watchlists')).body.items[0].folderId).toBe(other.id);
    expect((await get('/watchlists/folders')).body.items.some((item: { id: string }) => item.id === other.id)).toBe(true);
  });

  it('returns explicit resource limits rather than silently truncating the bounded aggregate', async () => {
    await harness.ownerPool.query("INSERT INTO watchlist_folders(user_id,name) SELECT $1,'Folder '||n FROM generate_series(1,99) n", [alice.id]);
    expect((await mutate('post', '/watchlists/folders', { name: 'Too many' })).status).toBe(409);
    const defaultFolder = (await harness.ownerPool.query('SELECT id FROM watchlist_folders WHERE user_id=$1 AND is_default', [alice.id])).rows[0];
    await harness.ownerPool.query(`WITH added AS (INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,paused,provider)
      SELECT 'BULK'||n,'Bulk','NSE','INR',1,'EQUITY',true,false,'fixture' FROM generate_series(1,1000) n RETURNING id)
      INSERT INTO watchlist_entries(user_id,folder_id,instrument_id) SELECT $1,$2,id FROM added`, [alice.id, defaultFolder.id]);
    const rejected = await mutate('post', '/watchlists/entries', { instrumentId });
    expect(rejected.status).toBe(409); expect(rejected.body.error.code).toBe('RESOURCE_LIMIT');
    const all = (await get('/watchlists')).body;
    expect(all.folders).toHaveLength(100); expect(all.items).toHaveLength(1000);
  });

  it('fails closed for stale, closed, future, paused and inactive-owner observations and atomically rolls back a failed notification', async () => {
    await mutate('post', '/alerts', { instrumentId, condition: 'ABOVE', targetPrice: '1' });
    for (const [age, session] of [['61 seconds', 'REGULAR'], ['0 seconds', 'CLOSED'], ['-6 seconds', 'REGULAR']]) {
      await quote('100', age, session); await evaluateAlerts(harness.appPool); expect((await get('/notifications')).body.items).toEqual([]);
    }
    await quote('100'); await harness.ownerPool.query('UPDATE instruments SET paused=true WHERE id=$1', [instrumentId]);
    await evaluateAlerts(harness.appPool); expect((await get('/notifications')).body.items).toEqual([]);
    await harness.ownerPool.query('UPDATE instruments SET paused=false WHERE id=$1', [instrumentId]);
    await harness.ownerPool.query('UPDATE users SET active=false WHERE id=$1', [alice.id]); await evaluateAlerts(harness.appPool);
    expect((await harness.ownerPool.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n).toBe(0);
    await harness.ownerPool.query('UPDATE users SET active=true WHERE id=$1', [alice.id]);
    await harness.ownerPool.query(`CREATE FUNCTION tools_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END; $$;
      CREATE TRIGGER tools_fault AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION tools_fault()`);
    await expect(evaluateAlerts(harness.appPool)).rejects.toThrow('test rollback');
    expect((await get('/alerts')).body.items[0]).toMatchObject({ active: true, triggeredAt: null });
    await harness.ownerPool.query('DROP TRIGGER tools_fault ON notifications');
    await evaluateAlerts(harness.appPool); expect((await get('/notifications')).body.items).toHaveLength(1);
  });

  it('requires sessions, origin and CSRF and rejects malformed IDs, extra fields and unsafe bounded inputs', async () => {
    expect((await request(app).get('/api/notes')).status).toBe(401);
    expect((await request(app).post('/api/notes').set('Origin', origin).set('Cookie', alice.cookie).send({ title: 'x', body: '' })).status).toBe(403);
    expect((await request(app).post('/api/notes').set('Cookie', alice.cookie).set('X-CSRF-Token', alice.csrf).send({ title: 'x', body: '' })).status).toBe(403);
    for (const targetPrice of ['0', '-1', 'NaN', '1e2', '1.000000001', '1000000000000', 100]) expect((await mutate('post', '/alerts', { instrumentId, condition: 'ABOVE', targetPrice })).status).toBe(400);
    for (const path of ['/notes?limit=101', '/notes?limit=0', '/notes?cursor=garbage', '/notes?userId=x', '/watchlists/folders?limit=1.5', '/watchlists/entries?folderId=bad']) expect((await get(path)).status).toBe(400);
    expect((await mutate('post', '/notes', { title: 'x', body: 'x'.repeat(10001) })).status).toBe(400);
    expect((await mutate('post', '/notes', { title: 'x', body: '', userId: bob.id })).status).toBe(400);
    expect((await mutate('post', '/watchlists/folders', { name: ' '.repeat(3) })).status).toBe(400);
    expect((await mutate('post', '/watchlists/entries', { instrumentId: randomUUID() })).status).toBe(404);
    expect((await mutate('post', '/notes', { title: 'x', body: '', instrumentId: randomUUID() })).status).toBe(404);
    expect((await mutate('patch', '/notes/bad', { title: 'x' })).status).toBe(400);
    expect((await mutate('post', '/notifications/read', { ids: [] })).status).toBe(400);
    expect((await mutate('post', '/notifications/read', { ids: [instrumentId, instrumentId] })).status).toBe(400);
    expect((await mutate('post', '/notifications/read', { ids: [randomUUID()] })).status).toBe(404);
  });
});
