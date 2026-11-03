import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createHarness } from './harness.js';
import { migrate } from '../src/platform/migrate.js';
import { reconcileAccount } from '../src/modules/accounts/reconciliation.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
async function freePort(){const server=netServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('No port');await new Promise<void>(r=>server.close(()=>r()));return address.port;}
async function stop(child:ChildProcess){if(child.exitCode!=null||child.signalCode!=null)return;const closed=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);await closed;clearTimeout(timer);}
const h=await createHarness(),processes:ChildProcess[]=[];
let browser;
// Controlled HTTP boundary; the real API, provider adapter, migrations and ledger run below.
const instrument={symbol:'AAPL',name:'Apple Inc.',exchange:'NMS',currency:'USD',multiplier:'1',kind:'EQUITY',tradable:true,unavailableReason:null};
const observedAt=new Date(Date.now()-3*86400000).toISOString();
const bridge=createServer((request,response)=>{
  const url=new URL(request.url!,'http://market-data');
  const data=url.pathname==='/search'?{items:url.searchParams.get('q')?.startsWith('^')?[]:[instrument]}:
    url.pathname==='/quote'?{instrument,quote:{rawPrice:'200',rawCurrency:'USD',observedAt,session:'UNKNOWN',actionKey:'yfinance-raw'}}:
    url.pathname==='/fx'?{currency:url.searchParams.get('currency'),rate:url.searchParams.get('currency')==='USD'?'94':'1',observedAt}:
    {instrument,items:[{observedAt,open:'199',high:'201',low:'198',close:'200',volume:'123'}]};
  response.setHeader('Content-Type','application/json');response.end(JSON.stringify(data));
});
try {
  await migrate(h.ownerPool);await new Promise<void>(r=>bridge.listen(0,'127.0.0.1',r));
  const address=bridge.address();if(!address||typeof address==='string')throw Error('No bridge address');
  const apiPort=await freePort(),webPort=await freePort(),origin=`http://127.0.0.1:${webPort}`;
  const db=new URL('postgresql://127.0.0.1:55439');db.username=String(h.appPool.options.user);db.password=String(h.appPool.options.password);db.pathname=String(h.appPool.options.database);
  const launch=(args:string[],env:NodeJS.ProcessEnv)=>{const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,...env},stdio:['ignore','ignore','pipe']});processes.push(child);return child;};
  launch(['apps/server/dist/src/api.js'],{NODE_ENV:'test',PORT:String(apiPort),DATABASE_URL:db.href,PUBLIC_ORIGIN:origin,CSRF_SECRET:'yfinance browser test secret at least32bytes',MARKET_PROVIDER:'yfinance',YFINANCE_URL:`http://127.0.0.1:${address.port}`});
  launch(['frontend/node_modules/vite/bin/vite.js','preview','frontend','--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_API_TARGET:`http://127.0.0.1:${apiPort}`});
  await expect.poll(async()=>{try{return(await fetch(`${origin}/api/health/ready`)).status}catch{return 0}},{timeout:15000}).toBe(200);
  browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${origin}/register`);await page.getByLabel('Username',{exact:true}).fill('yf_browser');await page.getByLabel('Email').fill('yf-browser@example.com');await page.getByLabel('Password',{exact:true}).fill('yfinance browser password');await page.getByLabel('Confirm Password').fill('yfinance browser password');await page.getByRole('button',{name:'Create Account'}).click();
  await expect(page).toHaveURL(/\/login$/);await page.getByLabel('Username',{exact:true}).fill('yf_browser');await page.getByLabel('Password',{exact:true}).fill('yfinance browser password');await page.getByRole('button',{name:'Sign In'}).click();await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(`${origin}/stocks/AAPL`);
  const trade=page.getByRole('button',{name:/^Trade$/}).first();await expect(trade).toBeEnabled();
  await expect(page.locator('main')).not.toContainText(/delayed|LIVE_MARKET_NOT_VALIDATED|Unknown session|Simulated fixture data/i);
  await trade.click();await page.locator('.zk-inputs input').first().fill('1');await page.locator('.zk-btn-submit').click();await expect(page.locator('.zk-card')).toHaveCount(0);
  const execution=(await h.appPool.query(`SELECT e.price::text,e.settlement::text,e.quote_observed_at,i.provider FROM executions e JOIN instruments i ON i.id=e.instrument_id`)).rows[0];
  assert.equal(execution.provider,'yfinance');assert.equal(execution.price,'200.00000000');assert.equal(execution.settlement,'18800.00');assert.equal(execution.quote_observed_at.toISOString(),observedAt);
  const userId=(await h.appPool.query("SELECT id FROM users WHERE username='yf_browser'")).rows[0]!.id;
  assert.equal((await reconcileAccount(h.appPool,userId)).balanced,true);assert.deepEqual(errors,[]);
  console.log('PASS: yfinance paper trade from production UI; old source time and UNKNOWN session; exact ledger price/FX; no delayed-data label');
} finally {
  await browser?.close();for(const child of processes.reverse())await stop(child);
  bridge.closeAllConnections();await new Promise<void>(r=>bridge.close(()=>r()));await h.close();
}
