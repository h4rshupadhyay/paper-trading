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
    await page.route(`**/api/instruments/${apple.id}/quote`, async route => {
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
      const finished = page.waitForEvent('requestfinished', request => request.url().endsWith(`/api/instruments/${apple.id}/quote`));
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
