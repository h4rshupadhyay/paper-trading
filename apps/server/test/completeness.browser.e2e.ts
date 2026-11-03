import { mkdir } from 'node:fs/promises';
// Regression coverage for the November completeness audit.
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
const failures: string[]=[];
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
  } catch(error) { failures.push(name);console.error('FAIL:',name,String(error)); } finally { await context.close(); }
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


  // Desired behavior after remediation.
  await scenario('statistics contract and fabricated index movement', async ({page, request, instrument}) => {
    const apple=await instrument('AAPL');
    const payload=await (await request.get(origin+`/api/instruments/${apple.id}/quote`)).json();
    assert.equal(payload.quote.open,undefined);
    await page.goto(origin+'/stocks/AAPL');
    await expect(page.locator('.stock-ticker')).toHaveText('AAPL');
    const values=await page.locator('.stat-item-value').allTextContents();
    assert.equal(values.length,10);
    assert.ok(values.every(v=>v.includes('—')));
    await expect(page.locator('.index-change')).toHaveCount(0);

  });
  await scenario('pending status response race', async ({page,request,headers,instrument}) => {
    const apple=await instrument('AAPL');
    const created=await request.post(origin+'/api/orders',{headers:{...headers,'Idempotency-Key':crypto.randomUUID()},data:{instrumentId:apple.id,side:'BUY',type:'LIMIT',quantity:'1',limitPrice:'1'}});
    assert.equal(created.status(),201);
    const held=gate(),requested=gate();
    await page.route('**/api/orders?*',async route=>{
      if(new URL(route.request().url()).searchParams.get('status')!=='OPEN')return route.continue();
      const response=await route.fetch();requested.release();await held.promise;await route.fulfill({response});
    });
    try {
      await page.goto(origin+'/pending-orders');await requested.promise;
      await page.getByRole('button',{name:'FILLED',exact:true}).click();
      await expect(page.locator('.empty-state')).toContainText('No filled orders');
      const finished=page.waitForEvent('requestfinished',r=>new URL(r.url()).searchParams.get('status')==='OPEN');
      held.release();await finished;await renderSettled(page);
      await expect(page.locator('.status-tab.active')).toContainText('FILLED');
      await expect(page.locator('tbody .status-pill')).toHaveCount(0);
    } finally {held.release();}
  });
  await scenario('stock folder add can persist in the wrong folder after a failed second write',async ({page,request,headers,instrument})=>{
    await instrument('AAPL');
    const folder=await (await request.post(origin+'/api/watchlists/folders',{headers,data:{name:'Chosen list'}})).json();
    await page.goto(origin+'/stocks/AAPL');await expect(page.locator('.stock-ticker')).toHaveText('AAPL');
    await page.route('**/api/watchlists/entries/*',async route=>{
      if(route.request().method()==='PATCH')return route.fulfill({status:503,json:{error:{code:'SERVICE_UNAVAILABLE',message:'Move failed'}}});
      return route.continue();
    });
    await page.getByRole('button',{name:'Watch',exact:true}).click();
    await page.getByRole('button',{name:'Chosen list',exact:true}).dispatchEvent('mousedown');
    await expect(page.getByRole('button',{name:'Unwatch',exact:true})).toBeVisible();
    const list=await (await request.get(origin+'/api/watchlists')).json();
    assert.equal(list.items.length,1);assert.equal(list.items[0].folderId,folder.folder.id);
    await expect(page.getByRole('button',{name:'Watch',exact:true})).toHaveCount(0);
  });

  await scenario('analytics period response race',async ({page})=>{
    const held=gate(),requested=gate();
    await page.route('**/api/portfolio/snapshots?*',async route=>{
      const days=new URL(route.request().url()).searchParams.get('days');
      if(days==='30'){requested.release();await held.promise;}
      const values=days==='30'?['150','100']:['220','200'];
      await route.fulfill({json:{items:values.map((v,i)=>({id:String(i),sampledAt:`2026-11-0${2-i}T00:00:00Z`,totalValue:v,cashBalance:v,holdingsValue:'0'})),nextCursor:null}});
    });
    try {
      await page.goto(origin+'/analytics');await requested.promise;
      await page.getByRole('button',{name:'7D',exact:true}).click();
      await expect(page.locator('.chart-section .card-sub')).toContainText('+10.00%');
      const finished=page.waitForEvent('requestfinished',r=>r.url().includes('/portfolio/snapshots?')&&new URL(r.url()).searchParams.get('days')==='30');
      held.release();await finished;await renderSettled(page);
      await expect(page.locator('.period-btn.active')).toHaveText('7D');
      await expect(page.locator('.chart-section .card-sub')).toContainText('+10.00%');
    } finally {held.release();}
  });
  await scenario('missing FX hides real holdings in analytics',async ({page,request,headers,instrument})=>{
    const apple=await instrument('AAPL');
    const buy=await request.post(origin+'/api/orders',{headers:{...headers,'Idempotency-Key':crypto.randomUUID()},data:{instrumentId:apple.id,side:'BUY',type:'MARKET',quantity:'1'}});
    assert.equal(buy.status(),201);assert.equal((await buy.json()).order.status,'FILLED');
    await h.ownerPool.query("DELETE FROM latest_fx_rates WHERE currency='USD'");
    const p=await (await request.get(origin+'/api/portfolio')).json();
    assert.equal(p.quality,'incomplete');assert.equal(p.positions.length,1);
    // Prevent unrelated Header FX refresh from repairing this missing observation.
    await page.route('**/api/fx-rates',route=>route.fulfill({json:{items:[],baseCurrency:'INR'}}));
    await page.goto(origin+'/analytics');
    await expect(page.locator('main')).toContainText('Some prices are unavailable');
    await expect(page.locator('.empty-state')).toHaveCount(0);
    await expect(page.locator('.stat-card').filter({hasText:'Profitable holdings'}).locator('.stat-value')).toHaveText('—');
    await expect(page.locator('.stat-card').filter({hasText:/^Holdings/}).locator('.stat-value')).toHaveText('1');
  });
  await scenario('stored statistics render with independent stale state and remain usable for quote trading',async ({page,instrument})=>{
    const apple=await instrument('AAPL');
    await h.ownerPool.query(`INSERT INTO latest_instrument_statistics(instrument_id,open,day_high,day_low,previous_close,volume,average_volume,market_cap,trailing_pe,fifty_two_week_high,fifty_two_week_low,provider,fetched_at,sector,description)
      VALUES($1,145,155,140,149,0,12345,2000000000,-5.25,180,100,'fixture',now()-interval '61 minutes','Technology','An example company.')`,[apple.id]);
    await page.goto(origin+'/stocks/AAPL');
    await expect(page.locator('.stat-item').filter({hasText:'P/E Ratio'})).toContainText('-5.25');
    await expect(page.locator('.stat-item').filter({hasText:/^Volume/}).locator('.stat-item-value')).toHaveText('0');
    await expect(page.locator('time.data-note')).toContainText('Updated');
    await expect(page.getByRole('button',{name:'Trade',exact:true})).toBeEnabled();
    await expect(page.locator('main')).toContainText('An example company.');
    await page.getByRole('button',{name:'1Y',exact:true}).click();
    await expect(page.getByRole('button',{name:'1Y',exact:true})).toHaveClass(/active/);
    await page.getByTitle('Refresh price',{exact:true}).click();
    await expect(page.getByRole('button',{name:'1Y',exact:true})).toHaveClass(/active/);
  });
  await scenario('first visit loads statistics directly and keeps routine diagnostics out of the page',async ({page,instrument})=>{
    await instrument('AAPL');
    let snapshotCalls=0;
    await page.route('**/snapshot',async route=>{
      snapshotCalls++;const response=await route.fetch();const data=await response.json();
      await route.fulfill({json:{...data,statistics:null}});
    });
    await page.route('**/statistics',route=>route.fulfill({json:{statistics:{open:'145',dayHigh:'155',dayLow:'140',previousClose:'149',volume:'0',averageVolume:'12345',marketCap:'2000000000',trailingPE:'-5.25',fiftyTwoWeekHigh:'180',fiftyTwoWeekLow:'100',quality:'fresh',fetchedAt:new Date().toISOString()}}}));
    await page.goto(origin+'/stocks/AAPL');
    await expect(page.locator('.stat-item').filter({hasText:'P/E Ratio'}).locator('.stat-item-value')).toHaveText('-5.25',{timeout:4000});
    assert.equal(snapshotCalls,1,'statistics should finish without waiting for the next quote poll');
    await expect(page.locator('main')).not.toContainText(/Quote:|Statistics:|trade eligibility|received /);
    await expect(page.locator('.topbar')).not.toContainText(/FX estimates|yfinance|fresh/);
    if(process.env.UI_REVIEW_DIR){
      await mkdir(process.env.UI_REVIEW_DIR,{recursive:true});
      for(const theme of ['dark','light']){
        if(theme==='light')await page.getByTitle('Switch to light mode',{exact:true}).click();
        for(const width of [1440,390]){
          await page.setViewportSize({width,height:width===390?844:1000});
          await renderSettled(page);
          await page.screenshot({path:`${process.env.UI_REVIEW_DIR}/stock-${theme}-${width}.png`,animations:'disabled'});
        }
      }
    }
  });
  await scenario('superseding refresh clears the initial statistics loading state',async ({page,instrument})=>{
    await instrument('AAPL');const held=gate(),requested=gate();let calls=0;
    const statistics={trailingPE:'12.5',quality:'fresh',fetchedAt:new Date().toISOString()};
    await page.route('**/snapshot',async route=>{const response=await route.fetch();const data=await response.json();await route.fulfill({json:{...data,statistics:++calls===1?null:statistics}})});
    await page.route('**/statistics',async route=>{requested.release();await held.promise;await route.fulfill({json:{statistics}})});
    try {
      await page.goto(origin+'/stocks/AAPL');await requested.promise;
      await expect(page.getByRole('status').filter({hasText:'Loading…'})).toBeVisible();
      await page.getByTitle('Refresh price',{exact:true}).click();
      await expect(page.locator('.stat-item').filter({hasText:'P/E Ratio'})).toContainText('12.50');
      await expect(page.getByRole('status').filter({hasText:'Loading…'})).toHaveCount(0);
    }finally{held.release();}
  });
  await scenario('exception warnings remain visible after routine diagnostics are removed',async ({page,instrument})=>{
    await instrument('AAPL');
    await page.route('**/snapshot',async route=>{const response=await route.fetch();const data=await response.json();await route.fulfill({json:{...data,quality:'stale',unavailableReason:null,statistics:{quality:'fresh',fetchedAt:new Date().toISOString()}}})});
    await page.goto(origin+'/stocks/AAPL');
    await expect(page.locator('main')).toContainText('Price is out of date');
    await expect(page.getByRole('button',{name:'Trade',exact:true})).toBeDisabled();
    await page.route('**/api/portfolio',async route=>{const response=await route.fetch();const data=await response.json();await route.fulfill({json:{...data,quality:'review'}})});
    await page.goto(origin+'/analytics');await expect(page.locator('main')).toContainText('Some holdings are under review');
    await page.goto(origin+'/dashboard');await expect(page.locator('main')).toContainText('Some holdings are under review');
  });
  await scenario('dashboard history failure does not hide account and retries clear errors',async ({page})=>{
    await page.route('**/api/portfolio/snapshots?*',route=>route.fulfill({status:503,json:{error:{message:'History unavailable'}}}));
    await page.goto(origin+'/dashboard');
    await expect(page.locator('.stat-card').filter({hasText:'Cash Available'})).toBeVisible();
    await expect(page.locator('main')).toContainText('History unavailable');
    await page.unroute('**/api/portfolio/snapshots?*');
    await page.getByRole('button',{name:'Refresh',exact:true}).first().click();
    await expect(page.locator('main')).not.toContainText('History unavailable');
    let failed=false;
    await page.route('**/api/portfolio',route=>{if(!failed){failed=true;return route.fulfill({status:503,json:{error:{message:'Portfolio unavailable'}}})}return route.continue()});
    await page.getByRole('button',{name:'Refresh',exact:true}).last().click();
    await expect(page.locator('main')).toContainText('Portfolio unavailable');
    await page.getByRole('button',{name:'Refresh',exact:true}).last().click();
    await expect(page.locator('main')).not.toContainText('Portfolio unavailable');
    await expect(page.locator('.stat-card').filter({hasText:'Cash Available'})).toBeVisible();
  });
  assert.deepEqual(failures,[], 'Completeness regressions');
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
