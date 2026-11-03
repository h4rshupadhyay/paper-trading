import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page } from '@playwright/test';
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
type Context = { page: Page };
async function scenario(name: string, run: (context: Context) => Promise<void>) {
  if (process.env.CATALOGUE_CASE && !name.includes(process.env.CATALOGUE_CASE)) return;
  if (!browser) throw Error('Browser not started');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const request = context.request;
  const username = `catalogue_${++sequence}`;
  const password = 'audit browser password';
  try {
    const register = await request.post(origin + '/api/auth/register', {
      headers: { Origin: origin }, data: { username, email: `${username}@example.com`, password },
    });
    assert.equal(register.status(), 201);
    assert.equal((await request.post(origin + '/api/auth/login', {
      headers: { Origin: origin }, data: { username, password },
    })).status(), 200);
    await run({ page });
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
    PORT: '3001', PUBLIC_ORIGIN: origin, CSRF_SECRET: 'catalogue-browser-test-secret-more-than-32-bytes' });
  api = createServer(createApp({ pool: h.appPool, config, logger }));
  const apiPort = await listen(api);
  web = spawn(process.execPath, ['frontend/node_modules/vite/bin/vite.js', 'preview', 'frontend',
    '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    cwd: root, env: { ...process.env, VITE_API_TARGET: `http://127.0.0.1:${apiPort}` }, stdio: 'ignore',
  });
  await expect.poll(async () => { try { return (await fetch(origin + '/api/health/ready')).status; } catch { return 0; } }).toBe(200);
  browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE ?? '/usr/bin/google-chrome',
    args: ['--no-sandbox'], headless: true });

  await scenario('form suggestions update when catalogue arrives after typing', async ({ page }) => {
    const held = gate(), requested = gate();
    await page.route('**/api/instruments', async route => {
      const response = await route.fetch(); requested.release(); await held.promise; await route.fulfill({ response });
    });
    try {
      await page.goto(origin + '/watchlist'); await requested.promise;
      const input = page.locator('.add-ticker-form input');
      await input.fill('RELIANCE');
      await expect(page.locator('.ticker-dropdown-item')).toHaveCount(0);
      held.release();
      await expect(page.locator('.ticker-dropdown-item')).toContainText('RELIANCE.NS');
      await input.press('ArrowDown'); await input.press('Enter');
      await expect(input).toHaveValue('RELIANCE.NS');
    } finally { held.release(); }
  });
  await scenario('header suggestions use a late catalogue without waiting for remote search', async ({ page }) => {
    const catalogue = gate(), requested = gate(), search = gate(), searching = gate();
    await page.route('**/api/instruments', async route => {
      const response = await route.fetch(); requested.release(); await catalogue.promise; await route.fulfill({ response });
    });
    await page.route('**/api/instruments?*', async route => {
      if (new URL(route.request().url()).searchParams.get('q') !== 'RELIANCE') return route.continue();
      const response = await route.fetch(), data = await response.json();
      data.items = []; // An older empty fallback must not clear newer local matches.
      searching.release(); await search.promise; await route.fulfill({ response, json: data });
    });
    try {
      await page.goto(origin + '/notes'); await requested.promise;
      await page.getByRole('textbox', { name: 'Search stocks', exact: true }).fill('RELIANCE');
      await searching.promise;
      catalogue.release();
      await expect(page.locator('.search-item')).toContainText('RELIANCE.NS');
      // A later fallback response must still be ignored after the local result wins.
      const done = page.waitForEvent('requestfinished', r => new URL(r.url()).searchParams.get('q') === 'RELIANCE');
      search.release(); await done; await renderSettled(page);
      await expect(page.locator('.search-item')).toContainText('RELIANCE.NS');
    } finally { catalogue.release(); search.release(); }
  });
  await scenario('failed catalogue can recover on focus without reloading the page', async ({ page }) => {
    await page.route('**/api/instruments', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Catalogue unavailable', requestId: 'catalogue' } } }));
    const failed = page.waitForEvent('requestfinished', r => new URL(r.url()).pathname === '/api/instruments' && !new URL(r.url()).search);
    await page.goto(origin + '/watchlist'); await failed; await renderSettled(page);
    const input = page.locator('.add-ticker-form input');
    await input.fill('RELIANCE');
    await input.press('Tab'); await renderSettled(page);
    await page.unroute('**/api/instruments');
    await input.click();
    await expect(page.locator('.ticker-dropdown-item')).toContainText('RELIANCE.NS');
    await expect(input).toHaveValue('RELIANCE');
    await input.press('ArrowDown'); await input.press('Enter');
    await expect(input).toHaveValue('RELIANCE.NS');
    await page.getByRole('textbox', { name: 'Search stocks', exact: true }).fill('RELIANCE');
    await expect(page.locator('.search-item')).toContainText('RELIANCE.NS');
  });
  await scenario('both controls share one pending catalogue and reuse it across routes', async ({ page }) => {
    const held = gate(), requested = gate();
    let requests = 0;
    await page.route('**/api/instruments', async route => {
      requests += 1;
      const response = await route.fetch(); requested.release(); await held.promise; await route.fulfill({ response });
    });
    try {
      await page.goto(origin + '/watchlist'); await requested.promise;
      await expect(page.getByRole('textbox', { name: 'Search stocks', exact: true })).toBeVisible();
      await expect(page.locator('.add-ticker-form input')).toBeVisible();
      await renderSettled(page);
      assert.equal(requests, 1, 'two mounted controls share one pending HTTP catalogue request');
      held.release();
      await page.locator('.add-ticker-form input').fill('RELIANCE');
      await expect(page.locator('.ticker-dropdown-item')).toContainText('RELIANCE.NS');
      await page.getByRole('link', { name: 'Alerts', exact: true }).click();
      await page.locator('.alert-form .ticker-input-wrap input').fill('RELIANCE');
      await expect(page.locator('.ticker-dropdown-item')).toContainText('RELIANCE.NS');
      await page.getByRole('textbox', { name: 'Search stocks', exact: true }).fill('RELIANCE');
      await expect(page.locator('.search-item')).toContainText('RELIANCE.NS');
      assert.equal(requests, 1, 'route remounts reuse the successful catalogue');
    } finally { held.release(); }
  });
  await scenario('a failed catalogue retries on route remount for both controls', async ({ page }) => {
    await page.route('**/api/instruments', route => route.fulfill({ status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Catalogue unavailable', requestId: 'catalogue' } } }));
    const failed = page.waitForEvent('requestfinished', r => new URL(r.url()).pathname === '/api/instruments' && !new URL(r.url()).search);
    await page.goto(origin + '/watchlist'); await failed; await renderSettled(page);
    await page.unroute('**/api/instruments');
    await page.getByRole('link', { name: 'Alerts', exact: true }).click();
    await page.locator('.alert-form .ticker-input-wrap input').fill('RELIANCE');
    await expect(page.locator('.ticker-dropdown-item')).toContainText('RELIANCE.NS');
    await page.getByRole('textbox', { name: 'Search stocks', exact: true }).fill('RELIANCE');
    await expect(page.locator('.search-item')).toContainText('RELIANCE.NS');
  });
  await scenario('shared suggestions retain region filtering and keyboard selection', async ({ page }) => {
    const loaded = page.waitForEvent('requestfinished', r => new URL(r.url()).pathname === '/api/instruments' && !new URL(r.url()).search);
    await page.goto(origin + '/watchlist'); await loaded; await renderSettled(page);
    const input = page.locator('.add-ticker-form input');
    await input.fill('AAPL');
    await expect(page.locator('.ticker-dropdown-item')).toHaveCount(0);
    await page.getByTitle('Change region', { exact: true }).click();
    await page.locator('.region-option').filter({ hasText: 'United States' }).click();
    await input.click();
    await expect(page.locator('.ticker-dropdown-item')).toContainText('AAPL');
    await input.press('ArrowDown'); await input.press('Enter');
    await expect(input).toHaveValue('AAPL');
    const search = page.getByRole('textbox', { name: 'Search stocks', exact: true });
    await search.fill('AAPL');
    await expect(page.locator('.search-item')).toContainText('AAPL');
    await search.press('ArrowDown'); await search.press('Enter');
    await expect(page).toHaveURL(/\/stocks\/AAPL$/);
  });
  await scenario('late catalogue does not reopen suggestions after focus leaves the input', async ({ page }) => {
    const held = gate(), requested = gate();
    await page.route('**/api/instruments', async route => {
      const response = await route.fetch(); requested.release(); await held.promise; await route.fulfill({ response });
    });
    try {
      await page.goto(origin + '/watchlist'); await requested.promise;
      const input = page.locator('.add-ticker-form input');
      await page.getByRole('textbox', { name: 'Search stocks', exact: true }).fill('RELIANCE');
      await input.fill('RELIANCE');
      await page.getByRole('heading', { name: 'Watchlist', exact: true }).click();
      const done = page.waitForEvent('requestfinished', r => new URL(r.url()).pathname === '/api/instruments' && !new URL(r.url()).search);
      held.release(); await done; await renderSettled(page);
      await expect(page.locator('.ticker-dropdown')).toHaveCount(0);
      await expect(page.locator('.search-dropdown')).toHaveCount(0);
      await input.click();
      await expect(page.locator('.ticker-dropdown-item')).toContainText('RELIANCE.NS');
    } finally { held.release(); }
  });
  await scenario('an empty successful catalogue remains cached and manual symbols still work', async ({ page }) => {
    let requests = 0;
    await page.route('**/api/instruments', route => {
      requests += 1;
      return route.fulfill({ json: { items: [], nextCursor: null } });
    });
    const loaded = page.waitForEvent('requestfinished', r => new URL(r.url()).pathname === '/api/instruments' && !new URL(r.url()).search);
    await page.goto(origin + '/watchlist'); await loaded; await renderSettled(page);
    const input = page.locator('.add-ticker-form input');
    await input.fill('RELIANCE.NS'); await input.press('Tab'); await input.click();
    await expect(page.locator('.ticker-dropdown-item')).toHaveCount(0);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('tbody')).toContainText('RELIANCE.NS');
    await page.getByRole('link', { name: 'Alerts', exact: true }).click();
    await page.locator('.alert-form .ticker-input-wrap input').fill('RELIANCE');
    await renderSettled(page);
    assert.equal(requests, 1, 'an empty successful result is cached, rather than treated as a failed request');
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
