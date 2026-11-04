import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer,type Server } from 'node:http';
import { spawn,type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium,expect,type Page,type APIRequestContext } from '@playwright/test';
import { createApp } from '../src/app.js';
import { createSafeLogger } from '../src/platform/logging.js';
import { loadConfig } from '../src/platform/config.js';
import { migrate } from '../src/platform/migrate.js';
import { createHarness } from './harness.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { hashPassword } from '../src/modules/identity/passwords.js';
import { login } from '../src/modules/identity/sessions.js';
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
  const runtimeErrors:string[]=[];page.on('pageerror',error=>runtimeErrors.push(error.stack??error.message));
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
  } catch(error) { try{await page.screenshot({path:'/tmp/portfolio-chart-failure.png',fullPage:true})}catch{}; console.error('RUNTIME',runtimeErrors,'URL',page.url(),await page.locator('body').innerText()); failures.push(name);console.error('FAIL:',name,String(error)); } finally { await context.close(); }
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

  await scenario('Portfolio chart ranges, race, sparse and responsive render',async({page})=>{
    const user=(await h.ownerPool.query("SELECT id FROM users WHERE username='interaction_1'")).rows[0].id;
    await h.ownerPool.query(`INSERT INTO portfolio_snapshots(account_id,account_sequence,sample_bucket,sampled_at,cash_balance,holdings_value,total_value,unrealized_pl,quality)
      SELECT a.id,1,t,t,900000,100000+n*100,1000000+n*100,0,'fresh'
      FROM accounts a CROSS JOIN generate_series(now()-interval '5 years'+interval '1 day',now()-interval '1 day',interval '1 day') WITH ORDINALITY x(t,n) WHERE a.user_id=$1`,[user]);
    for(const surface of ['analytics','dashboard']) {
    await page.goto(origin+'/'+(surface==='dashboard'?'':surface));
    const chart=page.locator('.chart-section');
    const group=page.getByRole('group',{name:'Portfolio history range'});
    await expect(group.getByRole('button',{name:'5Y',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(chart.locator('.recharts-area-curve')).toBeVisible();
    assert.match((await chart.locator('.recharts-xAxis').textContent())??'',/202[1-6]/);
    for(const label of ['1D','5D','1M','3M','6M','1Y','5Y']){
      const response=page.waitForResponse(r=>r.url().includes('/portfolio/history?period=')&&r.status()===200);
      await group.getByRole('button',{name:label,exact:true}).click();await response;
      await expect(group.getByRole('button',{name:label,exact:true})).toHaveAttribute('aria-pressed','true');
      if(label==='1D')await expect(chart).toContainText('Not enough samples');
      else await expect(chart.locator('.recharts-area-curve')).toBeVisible();
    }
    await mkdir(root+'artifacts/five-year-chart',{recursive:true});
    await page.screenshot({path:root+'artifacts/five-year-chart/'+surface+'-desktop.png',fullPage:true});
    await chart.locator('.recharts-surface').first().hover({position:{x:200,y:100}});
    await expect(chart.locator('.tooltip-label, .recharts-tooltip-label')).toContainText(/202[1-6]/);
    // The old response arrives last; selection and result must stay on 5Y.
    let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
    await page.route('**/portfolio/history?period=1mo',async route=>{const response=await route.fetch();await gate;await route.fulfill({response});});
    const pending=page.waitForRequest('**/portfolio/history?period=1mo');
    await group.getByRole('button',{name:'1M',exact:true}).click();await pending;
    await expect(chart.getByRole('status')).toContainText('Loading chart');
    await group.getByRole('button',{name:'5Y',exact:true}).click();
    await expect(chart.locator('.recharts-area-curve')).toBeVisible();
    const oldResponse=page.waitForResponse('**/portfolio/history?period=1mo');release();await oldResponse;
    await expect(group.getByRole('button',{name:'5Y',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(chart.locator('.recharts-xAxis')).toContainText('2021');
    await page.unroute('**/portfolio/history?period=1mo');
    await page.setViewportSize({width:390,height:844});
    for(const label of ['1D','5D','1M','3M','6M','1Y','5Y'])await expect(group.getByRole('button',{name:label,exact:true})).toBeInViewport();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'No horizontal page overflow');
    await page.screenshot({path:root+'artifacts/five-year-chart/'+surface+'-narrow.png',fullPage:true});
    await page.route('**/portfolio/history?period=1d',route=>route.fulfill({status:503,json:{error:{message:'History unavailable'}}}));
    await group.getByRole('button',{name:'1D',exact:true}).click();await expect(chart.getByRole('alert')).toContainText('History unavailable');
    await expect(group.getByRole('button',{name:'5Y',exact:true})).toBeVisible();
    await page.unroute('**/portfolio/history?period=1d');
    await page.setViewportSize({width:1440,height:1000});
    }
  });
  assert.deepEqual(failures,[]);assert.equal(passed,1);
}finally{
 await browser?.close();
 if(web&&web.exitCode==null){const closed=new Promise<void>(resolve=>web!.once('exit',()=>resolve()));web.kill('SIGTERM');await closed;}
 if(api)await new Promise<void>(resolve=>api!.close(()=>resolve()));
 await h.close();
}
