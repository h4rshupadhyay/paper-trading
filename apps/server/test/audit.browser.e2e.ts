import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page, type APIRequestContext } from '@playwright/test';
import { createApp } from '../src/app.js';
import { createSafeLogger } from '../src/platform/logging.js';
import { loadConfig } from '../src/platform/config.js';
import { migrate } from '../src/platform/migrate.js';
import { createHarness } from './harness.js';
import { evaluateAlerts } from '../src/modules/user-tools/service.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const h = await createHarness();
let api: Server | undefined;
let web: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let origin = '';
let sequence = 0;
process.env.NODE_ENV = 'test';
process.env.MARKET_PROVIDER = 'fixture';

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No port');
  return address.port;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function renderSettled(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
type Context = {
  page: Page;
  request: APIRequestContext;
  headers: Record<string, string>;
  instrument(symbol: string): Promise<{ id: string; symbol: string }>;
};
async function scenario(name: string, run: (context: Context) => Promise<void>) {
  if (process.env.AUDIT_CASE && !name.includes(process.env.AUDIT_CASE)) return;
  if (!browser) throw Error('Browser not started');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const request = context.request;
  const username = `audit_${++sequence}`;
  const password = 'audit browser password';
  try {
    const register = await request.post(origin + '/api/auth/register', {
      headers: { Origin: origin }, data: { username, email: `${username}@example.com`, password },
    });
    assert.equal(register.status(), 201);
    assert.equal((await request.post(origin + '/api/auth/login', {
      headers: { Origin: origin }, data: { username, password },
    })).status(), 200);
    const csrf = await (await request.get(origin + '/api/auth/csrf')).json();
    const headers = { Origin: origin, 'X-CSRF-Token': csrf.csrfToken };
    await run({ page, request, headers, async instrument(symbol) {
      const data = await (await request.get(origin + '/api/instruments', { params: { q: symbol } })).json();
      const item = data.items.find((value: { symbol: string }) => value.symbol === symbol);
      assert.ok(item, `Instrument ${symbol} exists`);
      return item;
    } });
    console.log(`PASS: ${name}`);
  } finally { await context.close(); }
}

try {
  await migrate(h.ownerPool);
  const logger = createSafeLogger(() => {});
  // The real app/database run in-process; only external HTTP timing/failure is controlled.
  const reserve = createServer();
  const webPort = await listen(reserve);
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  origin = `http://127.0.0.1:${webPort}`;
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test',
    PORT: '3001', PUBLIC_ORIGIN: origin, CSRF_SECRET: 'audit-browser-test-secret-more-than-32-bytes' });
  api = createServer(createApp({ pool: h.appPool, config, logger }));
  const apiPort = await listen(api);
  web = spawn(process.execPath, ['frontend/node_modules/vite/bin/vite.js', 'preview', 'frontend',
    '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    cwd: root, env: { ...process.env, VITE_API_TARGET: `http://127.0.0.1:${apiPort}` }, stdio: 'ignore',
  });
  await expect.poll(async () => { try { return (await fetch(origin + '/api/health/ready')).status; } catch { return 0; } }).toBe(200);
  browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE ?? '/usr/bin/google-chrome',
    args: ['--no-sandbox'], headless: true });

  await scenario('late stock quote cannot replace the current trading instrument', async ({ page, instrument }) => {
    const apple = await instrument('AAPL');
    await instrument('RELIANCE.NS');
    await page.goto(origin + '/stocks/AAPL');
    await expect(page.locator('.stock-ticker')).toHaveText('AAPL');
    const held = gate(), requested = gate();
    await page.route(`**/api/instruments/${apple.id}/snapshot`, async route => {
      const response = await route.fetch();
      requested.release();
      await held.promise;
      await route.fulfill({ response });
    });
    try {
      await page.getByTitle('Refresh price', { exact: true }).click();
      await requested.promise;
      await page.getByRole('textbox', { name: 'Search stocks', exact: true }).fill('RELIANCE');
      await page.locator('.search-item').filter({ hasText: 'RELIANCE.NS' }).click();
      await expect(page).toHaveURL(/\/stocks\/RELIANCE.NS$/);
      await expect(page.locator('.stock-ticker')).toHaveText('RELIANCE.NS');
      const finished = page.waitForEvent('requestfinished', request => request.url().endsWith(`/api/instruments/${apple.id}/snapshot`));
      held.release();
      await finished;
      await renderSettled(page);
      await expect(page.locator('.stock-ticker')).toHaveText('RELIANCE.NS');
      await page.getByRole('button', { name: 'Trade', exact: true }).click();
      await expect(page.locator('.zk-ticker-name')).toHaveText('RELIANCE.NS');
    } finally { held.release(); }
  });
  await scenario('late note read cannot overwrite a new draft', async ({ page, request, headers }) => {
    const created = await request.post(origin + '/api/notes', { headers,
      data: { title: 'Existing note', body: 'Existing body' } });
    assert.equal(created.status(), 201);
    const id = (await created.json()).note.id;
    await page.goto(origin + '/notes');
    const held = gate(), requested = gate();
    await page.route(`**/api/notes/${id}`, async route => {
      const response = await route.fetch();
      requested.release(); await held.promise; await route.fulfill({ response });
    });
    try {
      await page.locator('.note-item').filter({ hasText: 'Existing note' }).click();
      await requested.promise;
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByPlaceholder('Note title…').fill('New draft');
      await page.getByPlaceholder('Write your note here…').fill('Keep these edits');
      const finished = page.waitForEvent('requestfinished', r => r.url().endsWith(`/api/notes/${id}`));
      held.release(); await finished; await renderSettled(page);
      await expect(page.getByPlaceholder('Note title…')).toHaveValue('New draft');
      await expect(page.getByPlaceholder('Write your note here…')).toHaveValue('Keep these edits');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.locator('.notes-list')).toContainText('New draft');
      const saved = await (await request.get(origin + '/api/notes')).json();
      assert.deepEqual(saved.items.map((n: { title: string }) => n.title).sort(), ['Existing note', 'New draft']);
    } finally { held.release(); }
  });
  await scenario('late search response cannot replace a newer local result', async ({ page }) => {
    await page.goto(origin + '/dashboard');
    await expect(page.getByPlaceholder('Search stocks… (e.g. AAPL, Tesla)')).toBeAttached();
    const held = gate(), requested = gate();
    await page.route('**/api/instruments?q=AAPL', async route => {
      const response = await route.fetch(); requested.release();
      await held.promise; await route.fulfill({ response });
    });
    try {
      const search = page.getByRole('textbox', { name: 'Search stocks', exact: true });
      await search.fill('AAPL'); await requested.promise;
      await search.fill('RELIANCE');
      await expect(page.locator('.search-item')).toContainText('RELIANCE.NS');
      const finished = page.waitForEvent('requestfinished', r => new URL(r.url()).searchParams.get('q') === 'AAPL');
      held.release(); await finished; await renderSettled(page);
      await expect(page.locator('.search-item')).toContainText('RELIANCE.NS');
      await expect(page.locator('.search-item')).not.toContainText('AAPL');
    } finally { held.release(); }
  });

  await scenario('accepted market order remains successful when account refresh fails', async ({ page, request, instrument }) => {
    await instrument('RELIANCE.NS');
    await page.goto(origin + '/stocks/RELIANCE.NS');
    await page.getByRole('button', { name: 'Trade', exact: true }).click();
    await page.getByLabel('Qty.', { exact: true }).fill('1');
    // The actual financial request succeeds; only its later display refresh fails.
    await page.route('**/api/account', route => route.fulfill({ status: 503,
      json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Account temporarily unavailable', requestId: 'audit' } } }));
    await page.getByRole('button', { name: 'Buy', exact: true }).click();
    await expect(page.locator('.zk-card')).toHaveCount(0);
    const orders = await (await request.get(origin + '/api/orders')).json();
    assert.equal(orders.items.length, 1);
    assert.equal(orders.items[0].status, 'FILLED');
    await expect(page.locator('main')).toContainText(/filled|executed|placed|completed/i);
    await expect(page.getByRole('alert')).toContainText('Account display could not refresh');
    await page.unroute('**/api/account');
    await page.getByRole('button', { name: 'Refresh account', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
  await scenario('candles show price direction and align with the plotted price axis', async ({ page, instrument }) => {
    const apple = await instrument('AAPL');
    await page.route(`**/api/instruments/${apple.id}/history?*`, async route => {
      const response = await route.fetch(), data = await response.json();
      data.items = [
        { observedAt: '2026-10-01T12:00:00Z', open: '100', close: '110', low: '90', high: '120', volume: '1000' },
        { observedAt: '2026-10-02T12:00:00Z', open: '110', close: '100', low: '90', high: '120', volume: '1000' },
      ];
      await route.fulfill({ response, json: data });
    });
    await page.goto(origin + '/stocks/AAPL');
    await page.getByTitle('Change region', { exact: true }).click();
    await page.locator('.region-option').filter({ hasText: 'United States' }).click();
    await expect(page.locator('.recharts-line-curve')).toHaveCount(1);
    // The existing line renderer provides an independent projection of the two known closes.
    const reference = await page.locator('.recharts-line-curve').evaluate(node => {
      const path = node as SVGPathElement;
      return { close110: path.getPointAtLength(0).y, close100: path.getPointAtLength(path.getTotalLength()).y };
    });
    await page.getByRole('button', { name: 'Candle', exact: true }).click();
    const candles = page.locator('.recharts-bar').last().locator('.recharts-bar-rectangle');
    await expect(candles).toHaveCount(2);
    await expect(candles.nth(0).locator('rect')).toHaveAttribute('fill', 'var(--green)');
    await expect(candles.nth(1).locator('rect')).toHaveAttribute('fill', 'var(--red)');
    const expectedY = (price: number) => reference.close100 + (price - 100) * (reference.close110 - reference.close100) / 10;
    for (const candle of await candles.all()) {
      const body = candle.locator('rect'), wick = candle.locator('line');
      assert.ok(Math.abs(Number(await body.getAttribute('y')) - expectedY(110)) < 1, 'Body top matches the plotted price110');
      assert.ok(Math.abs(Number(await body.getAttribute('height')) - Math.abs(expectedY(100) - expectedY(110))) < 1, 'Body height spans100 to110');
      assert.ok(Math.abs(Number(await wick.getAttribute('y1')) - expectedY(120)) < 1, 'Wick high matches price120');
      assert.ok(Math.abs(Number(await wick.getAttribute('y2')) - expectedY(90)) < 1, 'Wick low matches price90');
    }
  });
  await scenario('watchlist Add form retains the selected folder UUID', async ({ page, request, headers, instrument }) => {
    await instrument('RELIANCE.NS');
    const created = await request.post(origin + '/api/watchlists/folders', { headers, data: { name: 'Selected list' } });
    assert.equal(created.status(), 201);
    const folderId = (await created.json()).folder.id;
    await page.goto(origin + '/watchlist');
    await page.locator('.add-ticker-form .folder-select').selectOption(folderId);
    await page.locator('.add-ticker-form input').fill('RELIANCE.NS');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('tbody')).toContainText('RELIANCE.NS');
    const entries = await (await request.get(origin + '/api/watchlists/entries')).json();
    assert.equal(entries.items.length, 1);
    assert.equal(entries.items[0].folderId, folderId);
  });
  await scenario('failed note save preserves draft and can be retried', async ({ page, request }) => {
    await page.goto(origin + '/notes');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByPlaceholder('Note title…').fill('Keep draft');
    await page.getByPlaceholder('Write your note here…').fill('Keep body');
    await page.route('**/api/notes', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Save unavailable', requestId: 'audit' } } })
      : route.continue());
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Save unavailable');
    await expect(page.getByPlaceholder('Note title…')).toHaveValue('Keep draft');
    await expect(page.getByPlaceholder('Write your note here…')).toHaveValue('Keep body');
    await page.unroute('**/api/notes');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.notes-list')).toContainText('Keep draft');
    await expect(page.getByRole('alert')).toHaveCount(0);
    const saved = await (await request.get(origin + '/api/notes')).json();
    assert.equal(saved.items.length, 1);
  });
  await scenario('failed notes load offers retry instead of an empty collection', async ({ page, request, headers }) => {
    assert.equal((await request.post(origin + '/api/notes', { headers, data: { title: 'Loaded after retry', body: 'Body' } })).status(), 201);
    await page.route('**/api/notes?*', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Notes unavailable', requestId: 'audit' } } }));
    await page.goto(origin + '/notes');
    await expect(page.getByRole('alert')).toContainText('Notes unavailable');
    await expect(page.getByText('No notes yet. Click New to create one.')).toHaveCount(0);
    await page.unroute('**/api/notes?*');
    await page.getByRole('button', { name: 'Retry notes', exact: true }).click();
    await expect(page.locator('.notes-list')).toContainText('Loaded after retry');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
  await scenario('failed note open and delete remain visible and retryable', async ({ page, request, headers }) => {
    const response = await request.post(origin + '/api/notes', { headers, data: { title: 'Retain note', body: 'Retain content' } });
    assert.equal(response.status(), 201);
    const id = (await response.json()).note.id;
    const path = `**/api/notes/${id}`;
    await page.route(path, route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Note unavailable', requestId: 'audit' } } }));
    await page.goto(origin + '/notes');
    await page.locator('.note-item').click();
    await expect(page.getByRole('alert')).toContainText('Note unavailable');
    await page.unroute(path);
    await page.locator('.note-item').click();
    await expect(page.getByPlaceholder('Write your note here…')).toHaveValue('Retain content');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.route(path, route => route.request().method() === 'DELETE'
      ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Delete unavailable', requestId: 'audit' } } })
      : route.continue());
    page.on('dialog', dialog => dialog.accept());
    await page.getByTitle('Delete note', { exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Delete unavailable');
    await expect(page.getByPlaceholder('Write your note here…')).toHaveValue('Retain content');
    await expect(page.locator('.note-item')).toHaveCount(1);
    await page.unroute(path);
    await page.getByTitle('Delete note', { exact: true }).click();
    await expect(page.locator('.note-item')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    assert.equal((await (await request.get(origin + '/api/notes')).json()).items.length, 0);
  });
  await scenario('failed pending order load offers retry', async ({ page, request, headers, instrument }) => {
    const item = await instrument('AAPL');
    await request.get(origin + `/api/instruments/${item.id}/quote`);
    const placed = await request.post(origin + '/api/orders', { headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
      data: { instrumentId: item.id, side: 'BUY', type: 'LIMIT', quantity: '1', limitPrice: '1' } });
    assert.equal(placed.status(), 201);
    await page.route('**/api/orders?*', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Orders unavailable', requestId: 'audit' } } }));
    await page.goto(origin + '/pending-orders');
    await expect(page.locator('main').getByRole('alert')).toContainText('Orders unavailable');
    await expect(page.getByText('No open orders.', { exact: true })).toHaveCount(0);
    await page.unroute('**/api/orders?*');
    await page.getByRole('button', { name: 'Retry orders', exact: true }).click();
    await expect(page.locator('tbody')).toContainText('AAPL');
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
  });
  await scenario('failed alerts load and delete offer retry and retain alerts', async ({ page, request, headers, instrument }) => {
    const item = await instrument('AAPL');
    assert.equal((await request.post(origin + '/api/alerts', { headers,
      data: { instrumentId: item.id, condition: 'ABOVE', targetPrice: '100000' } })).status(), 201);
    await page.route('**/api/alerts?*', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Alerts unavailable', requestId: 'audit' } } }));
    await page.goto(origin + '/alerts');
    await expect(page.locator('main').getByRole('alert')).toContainText('Alerts unavailable');
    await expect(page.getByText('No alerts set. Create one above.')).toHaveCount(0);
    await page.unroute('**/api/alerts?*');
    await page.getByRole('button', { name: 'Retry alerts', exact: true }).click();
    await expect(page.locator('tbody')).toContainText('AAPL');
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    await page.route('**/api/alerts/*', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Alert delete unavailable', requestId: 'audit' } } }));
    await page.getByTitle('Delete alert', { exact: true }).click();
    await expect(page.locator('main').getByRole('alert')).toContainText('Alert delete unavailable');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.unroute('**/api/alerts/*');
    await page.getByTitle('Delete alert', { exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(0);
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    assert.equal((await (await request.get(origin + '/api/alerts')).json()).items.length, 0);
  });
  await scenario('failed notifications load and mark read offer retry', async ({ page, request, headers, instrument }) => {
    const item = await instrument('AAPL');
    await request.get(origin + `/api/instruments/${item.id}/quote`);
    assert.equal((await request.post(origin + '/api/alerts', { headers,
      data: { instrumentId: item.id, condition: 'ABOVE', targetPrice: '1' } })).status(), 201);
    // Run the real worker operation to create a notification; inspect via HTTP only.
    await evaluateAlerts(h.appPool);
    await page.route('**/api/notifications?*', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Notifications unavailable', requestId: 'audit' } } }));
    await page.goto(origin + '/alerts');
    await expect(page.locator('main').getByRole('alert')).toContainText('Notifications unavailable');
    await expect(page.getByText('No unread notifications.', { exact: true })).toHaveCount(0);
    await page.unroute('**/api/notifications?*');
    await page.locator('main').getByRole('button', { name: 'Retry notifications', exact: true }).click();
    await expect(page.locator('main .notif-item.unread')).toHaveCount(1);
    await page.route('**/api/notifications/read', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Mark read unavailable', requestId: 'audit' } } }));
    await page.locator('main').getByRole('button', { name: 'Mark all read', exact: true }).click();
    await expect(page.locator('main').getByRole('alert')).toContainText('Mark read unavailable');
    await expect(page.locator('main .notif-item.unread')).toHaveCount(1);
    await page.unroute('**/api/notifications/read');
    await page.locator('main').getByRole('button', { name: 'Mark all read', exact: true }).click();
    await expect(page.locator('main .notif-item.unread')).toHaveCount(0);
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    assert.equal((await (await request.get(origin + '/api/notifications?unread=true')).json()).items.length, 0);
  });
  await scenario('failed watchlist removal retains the entry and offers retry', async ({ page, request, headers, instrument }) => {
    const item = await instrument('RELIANCE.NS');
    const response = await request.post(origin + '/api/watchlists/entries', { headers, data: { instrumentId: item.id } });
    assert.equal(response.status(), 201);
    const path = `**/api/watchlists/entries/${(await response.json()).entry.id}`;
    await page.goto(origin + '/watchlist');
    await expect(page.locator('tbody')).toContainText('RELIANCE.NS');
    await page.route(path, route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Removal unavailable', requestId: 'audit' } } }));
    await page.getByTitle('Remove from this list', { exact: true }).click();
    await expect(page.locator('main').getByRole('alert')).toContainText('Removal unavailable');
    await expect(page.locator('tbody')).toContainText('RELIANCE.NS');
    await page.unroute(path);
    await page.getByTitle('Remove from this list', { exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(0);
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    assert.equal((await (await request.get(origin + '/api/watchlists/entries')).json()).items.length, 0);
  });
  await scenario('failed note open preserves an existing unsaved draft', async ({ page, request, headers }) => {
    const response = await request.post(origin + '/api/notes', { headers, data: { title: 'Existing', body: 'Existing body' } });
    const id = (await response.json()).note.id;
    await page.goto(origin + '/notes');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByPlaceholder('Note title…').fill('Unsaved draft');
    await page.getByPlaceholder('Write your note here…').fill('Unsaved body');
    await page.route(`**/api/notes/${id}`, route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Open unavailable', requestId: 'audit' } } }));
    await page.locator('.note-item').click();
    await expect(page.getByRole('alert')).toContainText('Open unavailable');
    await expect(page.getByPlaceholder('Note title…')).toHaveValue('Unsaved draft');
    await expect(page.getByPlaceholder('Write your note here…')).toHaveValue('Unsaved body');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.notes-list')).toContainText('Unsaved draft');
    assert.equal((await (await request.get(origin + '/api/notes')).json()).items.length, 2);
  });
  await scenario('late note save and delete cannot replace a newer draft', async ({ page, request }) => {
    await page.goto(origin + '/notes');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByPlaceholder('Note title…').fill('First saved');
    const heldSave = gate(), saved = gate();
    await page.route('**/api/notes', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); saved.release(); await heldSave.promise; await route.fulfill({ response });
    });
    try {
      await page.getByRole('button', { name: 'Save', exact: true }).click(); await saved.promise;
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByPlaceholder('Note title…').fill('Second draft');
      const finished = page.waitForEvent('requestfinished', r => r.method() === 'POST' && r.url().endsWith('/api/notes'));
      heldSave.release(); await finished;
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
      await page.unroute('**/api/notes');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.locator('.notes-list')).toContainText('Second draft');
      const notes = await (await request.get(origin + '/api/notes')).json();
      assert.deepEqual(notes.items.map((n: { title: string }) => n.title).sort(), ['First saved', 'Second draft']);
      const first = notes.items.find((n: { title: string }) => n.title === 'First saved');
      await page.locator('.note-item').filter({ hasText: 'First saved' }).click();
      await expect(page.getByPlaceholder('Note title…')).toHaveValue('First saved');
      const heldDelete = gate(), deleted = gate();
      await page.route(`**/api/notes/${first.id}`, async route => {
        const response = await route.fetch(); deleted.release(); await heldDelete.promise; await route.fulfill({ response });
      });
      try {
        page.on('dialog', dialog => dialog.accept());
        await page.getByTitle('Delete note', { exact: true }).click(); await deleted.promise;
        await page.getByRole('button', { name: 'New', exact: true }).click();
        await page.getByPlaceholder('Note title…').fill('Third draft');
        const done = page.waitForEvent('requestfinished', r => r.method() === 'DELETE');
        heldDelete.release(); await done; await renderSettled(page);
        await expect(page.getByPlaceholder('Note title…')).toHaveValue('Third draft');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.locator('.notes-list')).toContainText('Third draft');
        const final = await (await request.get(origin + '/api/notes')).json();
        assert.deepEqual(final.items.map((n: { title: string }) => n.title).sort(), ['Second draft', 'Third draft']);
      } finally { heldDelete.release(); }
    } finally { heldSave.release(); }
  });
  await scenario('notification bell failures remain visible and retryable', async ({ page, request, headers, instrument }) => {
    const item = await instrument('AAPL');
    await request.get(origin + `/api/instruments/${item.id}/quote`);
    assert.equal((await request.post(origin + '/api/alerts', { headers,
      data: { instrumentId: item.id, condition: 'ABOVE', targetPrice: '1' } })).status(), 201);
    await evaluateAlerts(h.appPool);
    await page.route('**/api/notifications?*', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Bell load unavailable', requestId: 'audit' } } }));
    await page.goto(origin + '/notes');
    await page.getByTitle('Notifications', { exact: true }).click();
    const bell = page.locator('.notif-dropdown');
    await expect(bell.getByRole('alert')).toContainText('Bell load unavailable');
    await expect(bell.getByText('No unread notifications', { exact: true })).toHaveCount(0);
    await page.unroute('**/api/notifications?*');
    await bell.getByRole('button', { name: 'Retry notifications', exact: true }).click();
    await expect(bell.locator('.notif-dropdown-item')).toHaveCount(1);
    await page.route('**/api/notifications/read', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Bell mark unavailable', requestId: 'audit' } } }));
    await bell.getByRole('button', { name: 'Mark all read', exact: true }).click();
    await expect(bell.getByRole('alert')).toContainText('Bell mark unavailable');
    await expect(bell.locator('.notif-dropdown-item')).toHaveCount(1);
    await page.unroute('**/api/notifications/read');
    await bell.getByRole('button', { name: 'Mark all read', exact: true }).click();
    await expect(bell.getByText('No unread notifications', { exact: true })).toBeVisible();
    await expect(bell.getByRole('alert')).toHaveCount(0);
    assert.equal((await (await request.get(origin + '/api/notifications?unread=true')).json()).items.length, 0);
  });
  await scenario('stock watchlist failures stay visible and can be retried', async ({ page, request, instrument }) => {
    await instrument('RELIANCE.NS');
    await page.route('**/api/watchlists', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Watchlist load unavailable', requestId: 'audit' } } }));
    await page.goto(origin + '/stocks/RELIANCE.NS');
    await expect(page.locator('main').getByRole('alert')).toContainText('Watchlist load unavailable');
    await page.unroute('**/api/watchlists');
    await page.getByRole('button', { name: 'Retry watchlist', exact: true }).click();
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    await page.route('**/api/watchlists/entries', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Watch unavailable', requestId: 'audit' } } }));
    await page.getByTitle('Add to watchlist', { exact: true }).click();
    await page.getByRole('button', { name: 'Watchlist (default)', exact: true }).click();
    await expect(page.locator('main').getByRole('alert')).toContainText('Watch unavailable');
    await page.unroute('**/api/watchlists/entries');
    await page.getByTitle('Add to watchlist', { exact: true }).click();
    await page.getByRole('button', { name: 'Watchlist (default)', exact: true }).click();
    await expect(page.getByTitle('Remove from watchlist', { exact: true })).toBeVisible();
    await page.route('**/api/watchlists/entries/*', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Unwatch unavailable', requestId: 'audit' } } }));
    await page.getByTitle('Remove from watchlist', { exact: true }).click();
    await expect(page.locator('main').getByRole('alert')).toContainText('Unwatch unavailable');
    await expect(page.getByTitle('Remove from watchlist', { exact: true })).toBeVisible();
    await page.unroute('**/api/watchlists/entries/*');
    await page.getByTitle('Remove from watchlist', { exact: true }).click();
    await expect(page.getByTitle('Add to watchlist', { exact: true })).toBeVisible();
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    assert.equal((await (await request.get(origin + '/api/watchlists/entries')).json()).items.length, 0);
  });
  await scenario('saving the current note invalidates an older pending open', async ({ page, request, headers }) => {
    const first = await request.post(origin + '/api/notes', { headers, data: { title: 'Note A', body: 'Body A' } });
    const second = await request.post(origin + '/api/notes', { headers, data: { title: 'Note B', body: 'Body B' } });
    assert.equal(first.status(), 201); assert.equal(second.status(), 201);
    const id = (await second.json()).note.id;
    await page.goto(origin + '/notes');
    await page.locator('.note-item').filter({ hasText: 'Note A' }).click();
    await expect(page.getByPlaceholder('Note title…')).toHaveValue('Note A');
    const held = gate(), requested = gate();
    await page.route(`**/api/notes/${id}`, async route => {
      const response = await route.fetch(); requested.release(); await held.promise; await route.fulfill({ response });
    });
    try {
      await page.locator('.note-item').filter({ hasText: 'Note B' }).click(); await requested.promise;
      await page.getByPlaceholder('Write your note here…').fill('Saved A');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Note saved', { exact: true })).toBeVisible();
      const done = page.waitForEvent('requestfinished', r => r.url().endsWith(`/api/notes/${id}`));
      held.release(); await done; await renderSettled(page);
      await expect(page.getByPlaceholder('Note title…')).toHaveValue('Note A');
      await expect(page.getByPlaceholder('Write your note here…')).toHaveValue('Saved A');
      const b = await (await request.get(origin + `/api/notes/${id}`)).json();
      assert.equal(b.note.body, 'Body B');
    } finally { held.release(); }
  });
  await scenario('failed watchlist folder create and rename preserve entered names', async ({ page, request }) => {
    await page.goto(origin + '/watchlist');
    await page.getByTitle('New list', { exact: true }).click();
    await page.getByPlaceholder('e.g. Tech Stocks').fill('Keep list');
    await page.route('**/api/watchlists/folders', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Create list unavailable', requestId: 'audit' } } }));
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByPlaceholder('e.g. Tech Stocks')).toHaveValue('Keep list');
    await expect(page.locator('.modal-card').getByRole('alert')).toContainText('Create list unavailable');
    await page.unroute('**/api/watchlists/folders');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('.wl-tab-name').filter({ hasText: 'Keep list' })).toHaveCount(1);
    await page.locator('.wl-tab').filter({ hasText: 'Keep list' }).dblclick();
    await page.locator('.wl-tab-rename').fill('Revised list');
    await page.route('**/api/watchlists/folders/*', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Rename unavailable', requestId: 'audit' } } }));
    await page.locator('.wl-tab-rename').press('Enter');
    await expect(page.locator('.wl-tab-rename')).toHaveValue('Revised list');
    await expect(page.locator('main').getByRole('alert')).toContainText('Rename unavailable');
    await page.unroute('**/api/watchlists/folders/*');
    await page.locator('.wl-tab-rename').press('Enter');
    await expect(page.locator('.wl-tab-name').filter({ hasText: 'Revised list' })).toHaveCount(1);
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    const folders = await (await request.get(origin + '/api/watchlists/folders')).json();
    assert.equal(folders.items.filter((f: { name: string }) => f.name === 'Revised list').length, 1);
  });
} finally {
  await browser?.close();
  if (web && web.exitCode == null) {
    const closed = new Promise<void>(resolve => web!.once('exit', () => resolve()));
    web.kill('SIGTERM');
    await closed;
  }
  if (api) await new Promise<void>(resolve => api!.close(() => resolve()));
  await h.close();
}
