import { sampleSnapshots } from '../src/modules/portfolio/service.js';
import { evaluateAlerts } from '../src/modules/user-tools/service.js';
// Real form-driven interaction coverage; every scenario owns a new account and browser context.
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
import { registerUser } from '../src/modules/identity/registration.js';
import { hashPassword } from '../src/modules/identity/passwords.js';
import { login } from '../src/modules/identity/sessions.js';
import { demoHistory } from './fixtures/demo-history.js';
import { seedDemo } from '../src/modules/demo/seed.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const h = await createHarness();
let api: Server | undefined;
let web: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let origin = '';
let sequence = 0;
const csrfSecret = 'audit-browser-test-secret-more-than-32-bytes';
const failures: string[]=[];
let passed = 0;
process.env.NODE_ENV = 'test';
process.env.MARKET_PROVIDER = 'fixture';

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No port');
  return address.port;
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
  page.setDefaultTimeout(8000);
  const runtimeErrors:string[]=[];page.on('pageerror',error=>runtimeErrors.push(error.message));
  const request = context.request;
  const username = `interaction_${++sequence}`;
  const password = 'audit browser password';
  try {
    // Fixture setup must not exhaust the real 20-attempt/IP auth throttle as
    // this feature suite grows. Public auth journeys/limits have their own tests.
    await registerUser(h.appPool, { username, email: `${username}@example.com`, password }, hashPassword);
    const { session } = await login(h.appPool, { username, password }, csrfSecret);
    await context.addCookies([{ name: 'paper_session', value: session.token, domain: '127.0.0.1', path: '/api', httpOnly: true, sameSite: 'Lax' }]);
    const csrf = await (await request.get(origin + '/api/auth/csrf')).json();
    const headers = { Origin: origin, 'X-CSRF-Token': csrf.csrfToken };
    await run({ page, request, headers, async instrument(symbol) {
      const data = await (await request.get(origin + '/api/instruments', { params: { q: symbol } })).json();
      const item = data.items.find((value: { symbol: string }) => value.symbol === symbol);
      assert.ok(item, `Instrument ${symbol} exists`);
      return item;
    } });
    assert.deepEqual(runtimeErrors,[], 'No uncaught browser errors');
    passed++; console.log(`PASS: ${name}`);
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
    PORT: '3001', PUBLIC_ORIGIN: origin, CSRF_SECRET: csrfSecret });
  api = createServer(createApp({ pool: h.appPool, config, logger }));
  const apiPort = await listen(api);
  web = spawn(process.execPath, ['frontend/node_modules/vite/bin/vite.js', 'preview', 'frontend',
    '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    cwd: root, env: { ...process.env, VITE_API_TARGET: `http://127.0.0.1:${apiPort}` }, stdio: 'ignore',
  });
  await expect.poll(async () => { try { return (await fetch(origin + '/api/health/ready')).status; } catch { return 0; } }).toBe(200);
  browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE ?? '/usr/bin/google-chrome',
    args: ['--no-sandbox'], headless: true });


  await scenario('UI-001 watchlist folder lifecycle and duplicate entries', async ({page,request}) => {
    await page.goto(origin+'/watchlist');
    await expect(page.locator('.empty-state')).toContainText('This list is empty');
    await page.getByTitle('New list',{exact:true}).click();
    await expect(page.getByRole('button',{name:'Create',exact:true})).toBeDisabled();
    await page.getByPlaceholder('e.g. Tech Stocks').fill('Momentum');
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal((await (await request.get(origin+'/api/watchlists')).json()).folders.filter((f:any)=>!f.isDefault).length,0);
    await page.getByTitle('New list',{exact:true}).click();
    await page.getByPlaceholder('e.g. Tech Stocks').fill('Momentum');
    await page.getByRole('button',{name:'Create',exact:true}).click();
    await expect(page.locator('.wl-tab.active')).toContainText('Momentum');
    await page.locator('.wl-tab.active').dblclick();
    await page.locator('.wl-tab-rename').fill('Growth');
    await page.locator('.wl-tab-rename').press('Enter');
    await expect(page.locator('.wl-tab.active')).toContainText('Growth');
    const ticker=page.getByPlaceholder('Search ticker (e.g. RELIANCE.NS)');
    await ticker.fill('AAPL');await page.getByRole('button',{name:'Add',exact:true}).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await ticker.fill('AAPL');await page.getByRole('button',{name:'Add',exact:true}).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    let data=await (await request.get(origin+'/api/watchlists')).json();
    assert.equal(data.items.length,1);assert.equal(data.folders.find((f:any)=>f.id===data.items[0].folderId).name,'Growth');
    await page.locator('.wl-tab.active').hover();page.once('dialog',d=>d.dismiss());await page.getByTitle('Delete list',{exact:true}).click();
    await expect(page.locator('.wl-tab.active')).toContainText('Growth');
    await page.locator('.wl-tab.active').hover();page.once('dialog',d=>d.accept());await page.getByTitle('Delete list',{exact:true}).click();
    await expect(page.locator('.wl-tab.active')).toContainText('All');
    data=await (await request.get(origin+'/api/watchlists')).json();
    assert.equal(data.folders.filter((f:any)=>!f.isDefault).length,0);
    assert.equal(data.items.length,1);assert.equal(data.items[0].folderId,data.folders.find((f:any)=>f.isDefault).id);
    await page.getByTitle('Remove from this list',{exact:true}).click();
    await expect(page.locator('.empty-state')).toBeVisible();
    assert.equal((await (await request.get(origin+'/api/watchlists')).json()).items.length,0);
  });
  await scenario('UI-002 stock watch folder picker and unwatch persistence',async ({page,request,headers})=>{
    const {folder}=await (await request.post(origin+'/api/watchlists/folders',{headers,data:{name:'Quality'}})).json();
    await page.goto(origin+'/stocks/AAPL');
    await page.getByRole('button',{name:'Watch',exact:true}).click();
    await expect(page.locator('.wl-folder-picker')).toBeVisible();
    await page.locator('.stock-ticker').click();await expect(page.locator('.wl-folder-picker')).toHaveCount(0);
    await page.getByRole('button',{name:'Watch',exact:true}).click();
    await page.getByRole('button',{name:'Quality',exact:true}).dispatchEvent('mousedown');
    await expect(page.getByRole('button',{name:'Unwatch',exact:true})).toBeVisible();
    assert.equal((await (await request.get(origin+'/api/watchlists')).json()).items[0].folderId,folder.id);
    await page.reload();await page.getByRole('button',{name:'Unwatch',exact:true}).click();
    await expect(page.getByRole('button',{name:'Watch',exact:true})).toBeVisible();
    assert.equal((await (await request.get(origin+'/api/watchlists')).json()).items.length,0);
  });
  await scenario('UI-003 note create update close delete and empty title',async ({page,request})=>{
    await page.goto(origin+'/notes');await expect(page.locator('.notes-list-panel')).toContainText('No notes yet');
    await page.getByRole('button',{name:'New',exact:true}).click();
    await expect(page.getByRole('button',{name:'Save',exact:true})).toBeDisabled();
    await page.getByPlaceholder('Note title…').fill('   ');
    await expect(page.getByRole('button',{name:'Save',exact:true})).toBeDisabled();
    await page.getByPlaceholder('Note title…').fill('Investment thesis');
    await page.getByPlaceholder('Write your note here…').fill('First paragraph\nSecond paragraph');
    await page.getByPlaceholder('Link to ticker (optional)').fill('AAPL');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await expect(page.locator('.note-item')).toHaveCount(1);
    let list=await (await request.get(origin+'/api/notes')).json();assert.equal(list.items[0].symbol,'AAPL');
    const id=list.items[0].id;
    await page.getByPlaceholder('Note title…').fill('Revised thesis');
    await page.getByPlaceholder('Write your note here…').fill('Updated body');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await expect(page.locator('.note-item-title')).toHaveText('Revised thesis');
    await page.getByTitle('Close',{exact:true}).click();await expect(page.locator('.notes-empty-editor')).toBeVisible();
    await page.locator('.note-item').click();await expect(page.getByPlaceholder('Write your note here…')).toHaveValue('Updated body');
    const saved=await (await request.get(origin+'/api/notes/'+id)).json();assert.equal(saved.note.title,'Revised thesis');assert.equal(saved.note.body,'Updated body');assert.equal(saved.note.symbol,'AAPL');
    page.once('dialog',d=>d.dismiss());await page.getByTitle('Delete note',{exact:true}).click();
    assert.equal((await request.get(origin+'/api/notes/'+id)).status(),200);
    page.once('dialog',d=>d.accept());await page.getByTitle('Delete note',{exact:true}).click();
    await expect(page.locator('.note-item')).toHaveCount(0);assert.equal((await request.get(origin+'/api/notes/'+id)).status(),404);
  });
  await scenario('UI-004 above below alerts and individual all notification reads',async ({page,request,instrument})=>{
    const apple=await instrument('AAPL');await request.get(origin+`/api/instruments/${apple.id}/quote`);
    await page.goto(origin+'/alerts');await expect(page.locator('main')).toContainText('No alerts set');
    await page.getByRole('button',{name:'Set Alert',exact:true}).click();await expect(page.locator('.form-error')).toContainText('Fill in all fields');
    for(const [condition,price] of [['ABOVE','1'],['BELOW','999999']] as const){
      await page.getByPlaceholder('Search ticker (e.g. RELIANCE.NS)').fill('AAPL');
      await page.getByRole('button',{name:condition,exact:true}).click();await page.getByPlaceholder('Target price').fill(price);
      await page.getByRole('button',{name:'Set Alert',exact:true}).click();
      await expect(page.locator('tbody tr')).toHaveCount(condition==='ABOVE'?1:2);
    }
    const alerts=await (await request.get(origin+'/api/alerts')).json();assert.deepEqual(alerts.items.map((a:any)=>a.condition).sort(),['ABOVE','BELOW']);
    await evaluateAlerts(h.appPool);await page.reload();
    await expect(page.locator('main .notif-item.unread')).toHaveCount(2);
    await page.locator('main').getByTitle('Mark as read',{exact:true}).first().click();
    await expect(page.locator('main .notif-item.unread')).toHaveCount(1);
    assert.equal((await (await request.get(origin+'/api/notifications?unread=true')).json()).items.length,1);
    await page.locator('main').getByRole('button',{name:'Mark all read',exact:true}).click();
    await expect(page.locator('main .notif-item.unread')).toHaveCount(0);
    assert.equal((await (await request.get(origin+'/api/notifications?unread=true')).json()).items.length,0);
    await page.getByRole('button',{name:'Show all',exact:true}).click();await expect(page.locator('main .notif-item.read')).toHaveCount(2);
    await page.getByRole('button',{name:'Show unread',exact:true}).click();await expect(page.locator('main .notif-item')).toHaveCount(0);
    await page.getByTitle('Delete alert',{exact:true}).first().click();await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.getByTitle('Delete alert',{exact:true}).click();await expect(page.locator('tbody tr')).toHaveCount(0);
    assert.equal((await (await request.get(origin+'/api/alerts')).json()).items.length,0);
  });
  for(const type of ['MARKET','LIMIT','STOP_LIMIT','STOP'] as const) for(const side of ['BUY','SELL'] as const) {
    await scenario(`UI-005 ${side} ${type} order form persists exact intent`,async ({page,request,headers,instrument})=>{
      const apple=await instrument('AAPL');
      if(side==='SELL'){
        const seed=await request.post(origin+'/api/orders',{headers:{...headers,'Idempotency-Key':crypto.randomUUID()},data:{instrumentId:apple.id,side:'BUY',type:'MARKET',quantity:'5'}});
        assert.equal(seed.status(),201);assert.equal((await seed.json()).order.status,'FILLED');
      }
      await page.goto(origin+'/stocks/AAPL');await page.getByRole('button',{name:'Trade',exact:true}).click();
      if(side==='SELL') await page.getByTitle('Switch Buy / Sell',{exact:true}).click();
      await expect(page.locator('.zk-side-label')).toHaveText(side==='BUY'?'Buy':'Sell');
      await expect(page.getByRole('radio',{name:'CNC',exact:true})).toBeChecked();
      await expect(page.locator('input[name=productType]')).toHaveCount(1);
      await page.getByRole('radio',{name:({MARKET:'MARKET',LIMIT:'LIMIT',STOP_LIMIT:'SL',STOP:'SL-M'})[type],exact:true}).check();
      await expect(page.locator('.zk-btn-submit')).toBeDisabled();await page.getByLabel('Qty.',{exact:true}).fill('0');await expect(page.locator('.zk-btn-submit')).toBeDisabled();
      await page.getByLabel('Qty.',{exact:true}).fill('1.25');
      const limit=side==='BUY'?'1':'999999',stop=side==='BUY'?'999999':'1';
      if(type==='LIMIT'||type==='STOP_LIMIT')await page.getByLabel('Price',{exact:true}).fill(limit);
      else await expect(page.getByLabel('Price',{exact:true})).toBeDisabled();
      if(type==='STOP'||type==='STOP_LIMIT')await page.getByLabel('Trigger price',{exact:true}).fill(stop);
      else await expect(page.getByLabel('Trigger price',{exact:true})).toBeDisabled();
      await page.getByRole('button',{name:'More options',exact:true}).click();
      const expiry=new Date(Date.now()+86400000).toISOString().slice(0,16);
      if(type!=='MARKET')await page.getByLabel('Expires At',{exact:false}).fill(expiry);
      await page.getByRole('button',{name:'Hide options',exact:true}).click();
      await page.locator('.zk-btn-submit').click();await expect(page.locator('.zk-card')).toHaveCount(0);
      const orders=await (await request.get(origin+'/api/orders')).json();
      const order=orders.items.find((o:any)=>o.side===side&&o.type===type);assert.ok(order);
      assert.equal(Number(order.quantity),1.25);assert.equal(order.instrumentId,apple.id);
      assert.equal(order.status,type==='MARKET'?'FILLED':'OPEN');
      if(type==='LIMIT'||type==='STOP_LIMIT')assert.equal(Number(order.limitPrice),Number(limit));
      if(type==='STOP'||type==='STOP_LIMIT')assert.equal(Number(order.stopPrice),Number(stop));
      if(type!=='MARKET')assert.equal(new Date(order.expiresAt).getTime(),new Date(expiry).getTime());
      else assert.equal(order.expiresAt,null);
    });
  }
  await scenario('UI-006 modal cancel outside click invalid ticker and pending status navigation',async ({page,request,headers,instrument})=>{
    const apple=await instrument('AAPL');
    await page.goto(origin+'/pending-orders');
    await page.getByRole('button',{name:'New Order',exact:true}).click();
    await expect(page.getByRole('button',{name:'Continue →',exact:true})).toBeDisabled();
    await page.getByPlaceholder('e.g. AAPL, RELIANCE.NS').fill('DOESNOTEXIST');await page.getByRole('button',{name:'Continue →',exact:true}).click();
    await expect(page.locator('.form-error')).toContainText('Ticker not found');
    await page.getByPlaceholder('e.g. AAPL, RELIANCE.NS').fill('AAPL');await page.getByRole('button',{name:'Continue →',exact:true}).click();
    await page.getByLabel('Qty.',{exact:true}).fill('2');await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal((await (await request.get(origin+'/api/orders')).json()).items.length,0);
    await page.getByRole('button',{name:'New Order',exact:true}).click();await page.getByPlaceholder('e.g. AAPL, RELIANCE.NS').fill('AAPL');await page.getByRole('button',{name:'Continue →',exact:true}).click();
    await page.getByLabel('Qty.',{exact:true}).fill('2');await page.locator('.modal-overlay').click({position:{x:5,y:5}});
    await expect(page.locator('.modal-overlay')).toHaveCount(0);assert.equal((await (await request.get(origin+'/api/orders')).json()).items.length,0);
    const seed=await request.post(origin+'/api/orders',{headers:{...headers,'Idempotency-Key':crypto.randomUUID()},data:{instrumentId:apple.id,side:'BUY',type:'LIMIT',quantity:'1',limitPrice:'1'}});
    const {order}=await seed.json();assert.equal(seed.status(),201);
    await page.reload();await expect(page.locator('tbody tr')).toHaveCount(1);await page.getByTitle('Cancel order',{exact:true}).click();
    await expect(page.locator('tbody tr')).toHaveCount(0);
    const cancelled=await (await request.get(origin+'/api/orders')).json();assert.equal(cancelled.items.find((o:any)=>o.id===order.id).status,'CANCELLED');
    for(const status of ['TRIGGERED','FILLED','CANCELLED','REJECTED','EXPIRED','OPEN']){
      await page.getByRole('button',{name:status,exact:true}).click();
      if(status==='CANCELLED')await expect(page.locator('tbody .status-pill')).toHaveText('CANCELLED');
      else await expect(page.locator('.empty-state')).toContainText(`No ${status.toLowerCase()} orders`);
    }
  });
  await scenario('UI-007 history next back with 23 real orders',async ({page,request,headers,instrument})=>{
    const apple=await instrument('AAPL');
    for(let i=0;i<23;i++){
      const response=await request.post(origin+'/api/orders',{headers:{...headers,'Idempotency-Key':crypto.randomUUID()},data:{instrumentId:apple.id,side:'BUY',type:'LIMIT',quantity:String(i+1),limitPrice:'1'}});
      assert.equal(response.status(),201);
    }
    await page.goto(origin+'/orders');await expect(page.locator('tbody tr')).toHaveCount(20);
    const first=await page.locator('tbody tr td:first-child').allTextContents();
    await expect(page.locator('.pagination button').first()).toBeDisabled();await page.locator('.pagination button').last().click();
    await expect(page.locator('.page-info')).toHaveText('Page 2 of 2');await expect(page.locator('tbody tr')).toHaveCount(3);
    const last=await page.locator('tbody tr td:first-child').allTextContents();assert.equal(new Set([...first,...last]).size,23);
    await expect(page.locator('.pagination button').last()).toBeDisabled();await page.locator('.pagination button').first().click();
    await expect(page.locator('tbody tr')).toHaveCount(20);assert.deepEqual(await page.locator('tbody tr td:first-child').allTextContents(),first);
    await page.locator('tbody tr').first().getByRole('button').click();await expect(page).toHaveURL(origin+'/stocks/AAPL');
  });
  await scenario('UI-008 region theme persistence and search keyboard recovery',async ({page})=>{
    await page.goto(origin+'/dashboard');
    await page.getByTitle('Switch to light mode',{exact:true}).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme','light');
    await page.getByTitle('Change region',{exact:true}).click();await page.getByRole('button',{name:'🇺🇸 United States USD',exact:true}).click();
    await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await expect(page.locator('.region-code')).toHaveText('US');
    assert.equal(await page.evaluate(()=>localStorage.getItem('region')),'US');assert.equal(await page.evaluate(()=>localStorage.getItem('theme')),'light');
    const search=page.getByRole('textbox',{name:'Search stocks',exact:true});
    await search.fill('AAPL');await expect(page.getByRole('listbox')).toBeVisible();await search.press('Escape');await expect(page.getByRole('listbox')).toHaveCount(0);
    await search.fill('DOESNOTEXIST');await expect(page.locator('.search-empty')).toContainText('No results');
    await search.fill('AAPL');await expect(page.getByRole('listbox')).toBeVisible();await search.press('ArrowDown');await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected','true');await search.press('Enter');
    await expect(page).toHaveURL(origin+'/stocks/AAPL');await expect(search).toHaveValue('');
    await page.getByTitle('Switch to dark mode',{exact:true}).click();await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  });
  await scenario('UI-009 order required prices past expiry and insufficient shares',async ({page,request})=>{
    await page.goto(origin+'/stocks/AAPL');await page.getByRole('button',{name:'Trade',exact:true}).click();
    await page.getByLabel('Qty.',{exact:true}).fill('1');
    await page.getByRole('radio',{name:'LIMIT',exact:true}).check();await page.locator('.zk-btn-submit').click();
    await expect(page.locator('.zk-error')).toHaveText('Limit price is required');
    await page.getByRole('radio',{name:'SL-M',exact:true}).check();await page.locator('.zk-btn-submit').click();
    await expect(page.locator('.zk-error')).toHaveText('Trigger price is required');
    await page.getByRole('radio',{name:'SL',exact:true}).check();await page.getByLabel('Price',{exact:true}).fill('1');await page.locator('.zk-btn-submit').click();
    await expect(page.locator('.zk-error')).toHaveText('Trigger price is required');
    await page.getByLabel('Trigger price',{exact:true}).fill('999999');await page.getByRole('button',{name:'More options',exact:true}).click();
    await page.getByLabel('Expires At',{exact:false}).fill('2000-01-01T12:00');await page.locator('.zk-btn-submit').click();
    await expect(page.locator('.zk-error')).toHaveText('Expiry must be in the future');await expect(page.locator('.zk-card')).toBeVisible();
    assert.equal((await (await request.get(origin+'/api/orders')).json()).items.length,0);
    await page.getByRole('radio',{name:'MARKET',exact:true}).check();await page.getByTitle('Switch Buy / Sell',{exact:true}).click();await page.locator('.zk-btn-submit').click();
    await expect(page.locator('.zk-error')).toContainText(/shares|position|holdings/i);await expect(page.locator('.zk-card')).toBeVisible();
    const orders=await (await request.get(origin+'/api/orders')).json();assert.equal(orders.items.length,1);assert.equal(orders.items[0].status,'REJECTED');
    const portfolio=await (await request.get(origin+'/api/portfolio')).json();assert.equal(portfolio.positions.length,0);
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
  });
  await scenario('UI-026 insufficient SELL explains rejection and leaves ledger unchanged',async ({page,request})=>{
    const {user}=await (await request.get(origin+'/api/auth/me')).json();
    const ledger=async()=> (await h.ownerPool.query(`SELECT a.cash_balance::text AS balance,a.cash_sequence::text AS sequence,
      (SELECT count(*)::int FROM executions e WHERE e.account_id=a.id) AS executions,
      (SELECT count(*)::int FROM cash_movements m WHERE m.account_id=a.id) AS movements,
      (SELECT count(*)::int FROM positions p WHERE p.account_id=a.id) AS positions
      FROM accounts a WHERE a.user_id=$1`,[user.id])).rows[0];
    const before=await ledger();assert.equal(before.executions,0);assert.equal(before.positions,0);
    await page.goto(origin+'/stocks/AAPL');await page.getByRole('button',{name:'Trade',exact:true}).click();
    await page.getByTitle('Switch Buy / Sell',{exact:true}).click();await page.getByLabel('Qty.',{exact:true}).fill('1');
    await page.locator('.zk-btn-submit').click();await expect(page.locator('.zk-error')).toBeVisible();
    assert.deepEqual(await ledger(),before,'Rejected SELL cannot change cash, cash sequence, movements, executions or positions');
    const orders=await (await request.get(origin+'/api/orders')).json();assert.equal(orders.items.length,1);
    assert.equal(orders.items[0].status,'REJECTED');assert.equal(orders.items[0].rejectionReason,'INSUFFICIENT_POSITION');
    await expect(page.locator('.zk-error')).toHaveText(/You don[’']t have enough shares to sell\./);
  });
  await scenario('UI-027 every stock chart range renderer and refresh',async ({page,instrument})=>{
    const apple=await instrument('AAPL');await page.goto(origin+'/stocks/AAPL');
    await expect(page.locator('.price-chart .recharts-line-curve')).toHaveCount(1);
    for(const [label,period,interval] of [['1D','1d','5m'],['5D','5d','15m'],['1M','1mo','1d'],['3M','3mo','1d'],['6M','6mo','1d'],['1Y','1y','1wk'],['5Y','5y','1mo']] as const){
      const response=page.waitForResponse(r=>{const url=new URL(r.url());return url.pathname===`/api/instruments/${apple.id}/history`&&url.searchParams.get('period')===period&&url.searchParams.get('interval')===interval;});
      await page.locator('.price-chart').getByRole('button',{name:label,exact:true}).click();
      const history=await response;assert.equal(history.status(),200);assert.ok((await history.json()).items.length>1);
      await expect(page.locator('.price-chart .period-tabs .active')).toHaveText(label);
      await expect(page.locator('.price-chart .recharts-line-curve')).toHaveCount(1);
    }
    await page.getByRole('button',{name:'Candle',exact:true}).click();
    await expect(page.locator('.chart-type-tabs .active')).toHaveText('Candle');await expect(page.locator('.price-chart .recharts-line-curve')).toHaveCount(0);
    assert.ok(await page.locator('.price-chart .recharts-bar').last().locator('.recharts-bar-rectangle line').count()>1);
    await page.getByRole('button',{name:'Line',exact:true}).click();await expect(page.locator('.price-chart .recharts-line-curve')).toHaveCount(1);
    const refresh=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/instruments/${apple.id}/snapshot`);
    await page.getByTitle('Refresh price',{exact:true}).click();assert.equal((await refresh).status(),200);
    await expect(page.locator('.price-chart .period-tabs .active')).toHaveText('5Y');await expect(page.locator('.chart-type-tabs .active')).toHaveText('Line');
  });
  await scenario('UI-028 every analytics range and dashboard refresh control',async ({page,request,headers,instrument})=>{
    const apple=await instrument('AAPL');
    const buy=await request.post(origin+'/api/orders',{headers:{...headers,'Idempotency-Key':crypto.randomUUID()},data:{instrumentId:apple.id,side:'BUY',type:'MARKET',quantity:'2'}});
    assert.equal(buy.status(),201);assert.equal((await buy.json()).order.status,'FILLED');
    await sampleSnapshots(h.appPool);
    const {user}=await (await request.get(origin+'/api/auth/me')).json();
    // Copy this account's real valuation into an earlier seed bucket so every visible range has a chart.
    await h.ownerPool.query(`INSERT INTO portfolio_snapshots(account_id,account_sequence,sample_bucket,sampled_at,cash_balance,holdings_value,total_value,unrealized_pl,quality,observed_from,observed_to)
      SELECT s.account_id,s.account_sequence,s.sample_bucket-interval '2 days',s.sampled_at-interval '2 days',s.cash_balance,s.holdings_value,s.total_value,s.unrealized_pl,s.quality,s.observed_from,s.observed_to
      FROM portfolio_snapshots s JOIN accounts a ON a.id=s.account_id WHERE a.user_id=$1`,[user.id]);
    await page.goto(origin+'/analytics');await expect(page.locator('.chart-section .recharts-area-curve')).toHaveCount(1);
    for(const [label,period] of [['1D','1d'],['5D','5d'],['1M','1mo'],['3M','3mo'],['6M','6mo'],['1Y','1y'],['5Y','5y']] as const){
      const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/portfolio/history'&&new URL(r.url()).searchParams.get('period')===period);
      await page.getByRole('button',{name:label,exact:true}).click();const snapshots=await response;
      assert.equal(snapshots.status(),200);assert.equal((await snapshots.json()).items.length,period==='1d'?1:2);
      await expect(page.locator('.period-tabs .active')).toHaveText(label);await expect(page.locator('.chart-section .recharts-area-curve')).toHaveCount(period==='1d'?0:1);
    }
    const refreshed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/portfolio/history'&&new URL(r.url()).searchParams.get('period')==='5y');
    await page.getByTitle('Refresh',{exact:true}).click();assert.equal((await refreshed).status(),200);await expect(page.locator('.period-tabs .active')).toHaveText('5Y');
    await expect(page.locator('.composition-stats')).toContainText('Holdings');await expect(page.locator('.composition-stats')).toContainText('Cash');
    await expect(page.locator('.analytics-charts-row .recharts-pie')).toHaveCount(1);
    await expect(page.locator('.analytics-charts-row')).toContainText('Sector data unavailable for these holdings.');
    await page.goto(origin+'/dashboard');await expect(page.locator('.chart-section .recharts-area-curve')).toHaveCount(1);
    const history=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/portfolio/history');
    await page.locator('.chart-section').getByTitle('Refresh',{exact:true}).click();assert.equal((await history).status(),200);
    const portfolio=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/portfolio');
    await page.locator('section.card').filter({has:page.getByRole('heading',{name:'Holdings',exact:true})}).getByTitle('Refresh',{exact:true}).click();
    assert.equal((await portfolio).status(),200);await expect(page.locator('tbody tr')).toContainText('AAPL');
  });
  await scenario('UI-029 internal notification reads update both views immediately',async ({page,request,headers,instrument})=>{
    const apple=await instrument('AAPL');
    assert.equal((await request.get(origin+`/api/instruments/${apple.id}/quote`)).status(),200);
    for(const source of ['page','bell']){
      const alert=await request.post(origin+'/api/alerts',{headers,data:{instrumentId:apple.id,condition:'ABOVE',targetPrice:'1'}});
      assert.equal(alert.status(),201);await evaluateAlerts(h.appPool);
      await page.goto(origin+'/alerts');
      await expect(page.locator('.notif-badge')).toHaveText('1');
      await expect(page.locator('main .notif-item.unread')).toHaveCount(1);
      if(source==='page')await page.locator('main').getByTitle('Mark as read',{exact:true}).click();
      else {
        await page.getByTitle('Notifications',{exact:true}).click();
        await page.locator('.notif-dropdown').getByRole('button',{name:'Mark all read',exact:true}).click();
      }
      await expect(page.locator('.notif-badge')).toHaveCount(0,{timeout:2000});
      await expect(page.locator('main .notif-item.unread')).toHaveCount(0,{timeout:2000});
      assert.equal((await (await request.get(origin+'/api/notifications?unread=true')).json()).items.length,0);
    }
  });
  await scenario('UI-030 internal refresh is quiet for a minute and pauses in hidden tabs',async ({page})=>{
    await page.clock.install();
    const counts={alerts:0,notifications:0};
    page.on('request',r=>{const path=new URL(r.url()).pathname;if(path==='/api/alerts')counts.alerts++;if(path==='/api/notifications')counts.notifications++;});
    await page.goto(origin+'/alerts');await expect(page.locator('.card-sub').first()).toContainText('0 active');
    await page.waitForLoadState('networkidle');const initial={...counts};
    assert.ok(initial.alerts>0&&initial.notifications>0,'Mount reads immediately');
    await page.clock.runFor(31000);await page.waitForLoadState('networkidle');
    assert.deepEqual(counts,initial,'Internal reads must not poll every 15/30 seconds');
    await page.clock.runFor(30000);await page.waitForLoadState('networkidle');
    await expect.poll(()=>counts.alerts,{message:'Visible fallback refresh remains active'}).toBeGreaterThan(initial.alerts);
    await expect.poll(()=>counts.notifications).toBeGreaterThan(initial.notifications);
    await page.evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,get(){return 'hidden'}});document.dispatchEvent(new Event('visibilitychange'))");
    const hidden={...counts};await page.clock.runFor(120000);await page.waitForLoadState('networkidle');assert.deepEqual(counts,hidden);
    await page.evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,get(){return 'visible'}});document.dispatchEvent(new Event('visibilitychange'))");
    await expect.poll(()=>counts.alerts).toBeGreaterThan(hidden.alerts);
    await expect.poll(()=>counts.notifications).toBeGreaterThan(hidden.notifications);
  });
  await scenario('UI-031 internal saved records render without a second list request',async ({page})=>{
    await page.goto(origin+'/notes');await expect(page.locator('.notes-list-panel')).toContainText('No notes yet');
    await page.route('**/api/notes?*',route=>route.abort());
    await page.getByRole('button',{name:'New',exact:true}).click();
    await page.getByPlaceholder('Note title…').fill('Immediate note');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await expect(page.locator('.note-item-title')).toHaveText('Immediate note');
    await expect(page.locator('.notes-list-panel')).not.toContainText('Failed to load');
    await page.goto(origin+'/watchlist');await expect(page.locator('.empty-state')).toContainText('This list is empty');
    await page.route('**/api/watchlists',route=>route.request().method()==='GET'?route.abort():route.continue());
    await page.getByTitle('New list',{exact:true}).click();await page.getByPlaceholder('e.g. Tech Stocks').fill('Immediate list');
    await page.getByRole('button',{name:'Create',exact:true}).click();await expect(page.locator('.wl-tab.active')).toContainText('Immediate list');
    await page.locator('.wl-tab.active').dblclick();await page.locator('.wl-tab-rename').fill('Renamed immediately');await page.locator('.wl-tab-rename').press('Enter');
    await expect(page.locator('.wl-tab.active')).toContainText('Renamed immediately');
    await page.getByPlaceholder('Search ticker (e.g. RELIANCE.NS)').fill('AAPL');
    await page.getByRole('button',{name:'Add',exact:true}).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText('AAPL');
  });
  await scenario('UI-032 slow background reads neither overlap nor undo a confirmed notification read',async ({page,request,headers,instrument})=>{
    const apple=await instrument('AAPL');await request.get(origin+`/api/instruments/${apple.id}/quote`);
    assert.equal((await request.post(origin+'/api/alerts',{headers,data:{instrumentId:apple.id,condition:'ABOVE',targetPrice:'1'}})).status(),201);
    await evaluateAlerts(h.appPool);await page.clock.install();
    await page.goto(origin+'/alerts');await expect(page.locator('main .notif-item.unread')).toHaveCount(1);await expect(page.locator('.notif-badge')).toHaveText('1');
    let heldReads=0;let release=()=>{};
    const held=new Promise<void>(resolve=>{release=resolve;});
    await page.route('**/api/notifications?*',async route=>{
      const response=await route.fetch();heldReads++;await held;await route.fulfill({response});
    });
    try {
      await page.clock.runFor(61000);await expect.poll(()=>heldReads).toBe(2);
      await expect(page.locator('main .notif-item.unread')).toHaveCount(1);
      await page.clock.runFor(120000);assert.equal(heldReads,2,'No concurrent fallback requests while a previous refresh is pending');
      await page.locator('main').getByTitle('Mark as read',{exact:true}).click();
      await expect(page.locator('.notif-badge')).toHaveCount(0);await expect(page.locator('main .notif-item.unread')).toHaveCount(0);
      release();await page.waitForLoadState('networkidle');
      await expect(page.locator('.notif-badge')).toHaveCount(0);await expect(page.locator('main .notif-item.unread')).toHaveCount(0);
      assert.equal((await (await request.get(origin+'/api/notifications?unread=true')).json()).items.length,0);
    } finally {release();}
  });
  await scenario('UI-033 a late initial list cannot erase confirmed notes or folders',async ({page,request,headers})=>{
    assert.equal((await request.post(origin+'/api/notes',{headers,data:{title:'Earlier note',body:''}})).status(),201);
    let release=()=>{};let captured=()=>{};
    let held=new Promise<void>(resolve=>{release=resolve;});let ready=new Promise<void>(resolve=>{captured=resolve;});let first=true;
    await page.route('**/api/notes?*',async route=>{if(!first)return route.continue();first=false;const response=await route.fetch();captured();await held;await route.fulfill({response});});
    try {
      await page.goto(origin+'/notes');await ready;await page.getByRole('button',{name:'New',exact:true}).click();await page.getByPlaceholder('Note title…').fill('Newest note');
      await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('.note-item-title')).toHaveText('Newest note');
      release();await page.waitForLoadState('networkidle');
      await expect(page.locator('.notes-list')).toContainText('Earlier note');await expect(page.locator('.notes-list')).toContainText('Newest note');
    } finally {release();}
    assert.equal((await request.post(origin+'/api/watchlists/folders',{headers,data:{name:'Earlier folder'}})).status(),201);
    held=new Promise<void>(resolve=>{release=resolve;});ready=new Promise<void>(resolve=>{captured=resolve;});first=true;
    await page.route('**/api/watchlists',async route=>{if(!first||route.request().method()!=='GET')return route.continue();first=false;const response=await route.fetch();captured();await held;await route.fulfill({response});});
    try {
      await page.goto(origin+'/watchlist');await ready;await page.getByTitle('New list',{exact:true}).click();await page.getByPlaceholder('e.g. Tech Stocks').fill('Newest folder');
      await page.getByRole('button',{name:'Create',exact:true}).click();await expect(page.locator('.wl-tab.active')).toContainText('Newest folder');
      release();await page.waitForLoadState('networkidle');
      await expect(page.locator('.wl-tabs')).toContainText('Earlier folder');await expect(page.locator('.wl-tab.active')).toContainText('Newest folder');
    } finally {release();}
  });
  await scenario('UI-034 a refresh before a write response cannot duplicate watchlist records',async ({page})=>{
    await page.goto(origin+'/watchlist');await expect(page.locator('.empty-state')).toContainText('This list is empty');
    for(const kind of ['folders','entries']){
      let release=()=>{};let committed=()=>{};
      const held=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{committed=resolve;});
      let allowRead=()=>{};const readAllowed=new Promise<void>(resolve=>{allowRead=resolve;});
      await page.route('**/api/watchlists',async route=>{await readAllowed;await route.continue();});
      await page.route('**/api/watchlists/'+kind,async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();committed();await held;await route.fulfill({response});});
      try {
        await page.getByTitle('Refresh',{exact:true}).click();
        if(kind==='folders'){
          await page.getByTitle('New list',{exact:true}).click();await page.getByPlaceholder('e.g. Tech Stocks').fill('One folder');await page.getByRole('button',{name:'Create',exact:true}).click();
        }else{await page.getByPlaceholder('Search ticker (e.g. RELIANCE.NS)').fill('AAPL');await page.getByRole('button',{name:'Add',exact:true}).click();}
        await ready;allowRead();
        if(kind==='folders')await expect(page.locator('.wl-tab').filter({hasText:'One folder'})).toHaveCount(1);
        else await expect(page.locator('tbody tr')).toHaveCount(1);
        release();
        if(kind==='folders')await expect(page.getByPlaceholder('e.g. Tech Stocks')).toHaveCount(0);
        else await expect(page.getByPlaceholder('Search ticker (e.g. RELIANCE.NS)')).toHaveValue('');
        if(kind==='folders')await expect(page.locator('.wl-tab').filter({hasText:'One folder'})).toHaveCount(1);
        else await expect(page.locator('tbody tr')).toHaveCount(1);
      } finally {release();allowRead();await page.unroute('**/api/watchlists/'+kind);await page.unroute('**/api/watchlists');}
    }
  });
  await scenario('UI-035 seeded demo signs in normally and shows populated features',async ({page,request})=>{
    const password='demo browser password 123';
    await seedDemo(h.appPool,{password,nodeEnv:'test',provider:'fixture',history:demoHistory()});
    // Normal login form, including the usual cookie and CSRF/auth middleware.
    await page.goto(origin+'/login');
    // The scenario fixture is already signed in; revoke it before opening login.
    const csrf=await (await request.get(origin+'/api/auth/csrf')).json();
    assert.equal((await request.post(origin+'/api/auth/logout',{headers:{Origin:origin,'X-CSRF-Token':csrf.csrfToken}})).status(),204);
    await page.goto(origin+'/login');await page.getByLabel('Username',{exact:true}).fill('demo');
    await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign In',exact:true}).click();
    await expect(page.locator('.sidebar-user .user-name')).toHaveText('demo');
    await expect(page.locator('tbody tr')).toHaveCount(3);
    for(const symbol of ['AAPL','MSFT','RELIANCE.NS'])await expect(page.locator('tbody')).toContainText(symbol);
    const portfolio=await (await request.get(origin+'/api/portfolio')).json();assert.equal(portfolio.account.cashBalance,'707500.00');assert.equal(portfolio.positions.length,3);
    assert.equal((await (await request.get(origin+'/api/account/reconciliation')).json()).balanced,true);
    await page.goto(origin+'/notes');await expect(page.locator('.note-item')).toHaveCount(3);await expect(page.locator('.notes-list')).toContainText('Demo: history provenance');
    await page.goto(origin+'/pending-orders');await expect(page.locator('tbody tr')).toHaveCount(3);
    await page.goto(origin+'/watchlist');await expect(page.locator('tbody tr')).toHaveCount(3);
    assert.equal((await (await request.get(origin+'/api/notifications?unread=true')).json()).items.length,1);
  });
  console.log(`Interaction scenarios: ${passed} passed, ${failures.length} failed`);
  assert.deepEqual(failures,[], 'Interaction regressions');
  assert.ok(passed > 0, 'No interaction scenarios ran; check AUDIT_CASE');
} finally {
  await browser?.close();
  if(web && web.exitCode == null){const closed=new Promise<void>(resolve=>web!.once('exit',()=>resolve()));web.kill('SIGTERM');await closed;}
  if(api)await new Promise<void>(resolve=>api!.close(()=>resolve()));
  await h.close();
}
