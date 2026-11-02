import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {createHarness} from './harness.js';
import {migrate} from '../src/platform/migrate.js';
import {evaluatePending} from '../src/modules/trading/service.js';
import {evaluateAlerts} from '../src/modules/user-tools/service.js';
import {sampleSnapshots} from '../src/modules/portfolio/service.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
async function freePort(){const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('No port');const port=address.port;await new Promise<void>(r=>server.close(()=>r()));return port;}
async function stop(child:ChildProcess){if(child.exitCode!=null||child.signalCode!=null)return;const closed=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),12000);await closed;clearTimeout(timer);}
const h=await createHarness();const processes:ChildProcess[]=[];let browser;
try {
 await migrate(h.ownerPool);
 const apiPort=await freePort(),webPort=await freePort();const origin=`http://127.0.0.1:${webPort}`;
 const db=new URL('postgresql://127.0.0.1:55439');db.username=String(h.appPool.options.user);db.password=String(h.appPool.options.password);db.pathname=String(h.appPool.options.database);
 let output='';const launch=(args:string[],env:NodeJS.ProcessEnv)=>{const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});child.stdout?.on('data',c=>output+=c);child.stderr?.on('data',c=>output+=c);processes.push(child);return child;};
 launch(['apps/server/dist/src/api.js'],{NODE_ENV:'test',PORT:String(apiPort),DATABASE_URL:db.href,PUBLIC_ORIGIN:origin,CSRF_SECRET:'browser-test-secret-longer-than-thirty-two-bytes',MARKET_PROVIDER:'fixture'});
 launch(['frontend/node_modules/vite/bin/vite.js','frontend','--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_API_TARGET:`http://127.0.0.1:${apiPort}`});
 await expect.poll(async()=>{try{return(await fetch(`${origin}/api/health/ready`)).status}catch{return 0}},{timeout:15000}).toBe(200);
 browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE??'/usr/bin/google-chrome',args:['--no-sandbox'],headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`${origin}/register`);await page.getByLabel('Username',{exact:true}).fill('browser_trader');await page.getByLabel('Email').fill('browser@example.com');await page.getByLabel('Password',{exact:true}).fill('browser secure password');await page.getByLabel('Confirm Password').fill('browser secure password');await page.getByRole('button',{name:'Create Account'}).click();await expect(page.getByText('Account created!')).toBeVisible();
 await expect(page).toHaveURL(/\/login$/);await page.getByLabel('Username',{exact:true}).fill('browser_trader');await page.getByLabel('Password',{exact:true}).fill('browser secure password');await page.getByRole('button',{name:'Sign In'}).click();await expect(page).toHaveURL(/\/dashboard$/);
 const badResponses:string[]=[];page.on('response',response=>{if(response.url().includes('/api/')&&response.status()>=400)badResponses.push(`${response.status()} ${response.url()}`)});
 for(const path of ['/dashboard','/stocks/RELIANCE.NS','/orders','/watchlist','/pending-orders','/alerts','/notes','/analytics']) {
  await page.goto(origin+path);await expect(page.locator('main')).toBeVisible();await expect(page.locator('.splash')).toHaveCount(0);await page.waitForLoadState('networkidle');
 }
 await page.goto(`${origin}/stocks/RELIANCE.NS`);await expect(page.getByText('Simulated fixture data',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:/^Trade$/}).first().click();
 await page.locator('.zk-inputs input').first().fill('2.0000');await page.locator('.zk-btn-submit').click();await expect(page.locator('.zk-card')).toHaveCount(0);
 const movements=await h.appPool.query('SELECT amount::text FROM cash_movements ORDER BY account_sequence');assert.deepEqual(movements.rows,[{amount:'1000000.00'},{amount:'-300.00'}]);
 await page.goto(`${origin}/dashboard`);await expect(page.locator('table')).toContainText('RELIANCE.NS');
 // Use the authenticated browser's request context for owned mutations; these exercise the
 // same Origin/CSRF/cookie boundary as the retained pages, with actual PostgreSQL services.
 const csrf=await(await page.request.get(`${origin}/api/auth/csrf`)).json();const headers={Origin:origin,'X-CSRF-Token':csrf.csrfToken};
 const instruments=await(await page.request.get(`${origin}/api/instruments?q=RELIANCE`)).json();const instrumentId=instruments.items[0].id;
 const folder=await page.request.post(`${origin}/api/watchlists/folders`,{headers,data:{name:'Browser list'}});assert.equal(folder.status(),201);const folderId=(await folder.json()).folder.id;
 const watched=await page.request.post(`${origin}/api/watchlists/entries`,{headers,data:{instrumentId,folderId}});assert.equal(watched.status(),201);
 const note=await page.request.post(`${origin}/api/notes`,{headers,data:{title:'Browser journal',body:'Verified note',instrumentId}});assert.equal(note.status(),201);
 const alert=await page.request.post(`${origin}/api/alerts`,{headers,data:{instrumentId,condition:'ABOVE',targetPrice:'100'}});assert.equal(alert.status(),201);await evaluateAlerts(h.appPool);await sampleSnapshots(h.appPool);
 const pending=await page.request.post(`${origin}/api/orders`,{headers:{...headers,'Idempotency-Key':'browser-pending-01'},data:{instrumentId,side:'BUY',type:'STOP_LIMIT',quantity:'1',stopPrice:'100',limitPrice:'200'}});assert.equal(pending.status(),201);await evaluatePending(h.appPool);
 for(const [path,text] of [['/watchlist','RELIANCE.NS'],['/notes','Browser journal'],['/alerts','RELIANCE.NS'],['/pending-orders','FILLED'],['/orders','FILLED'],['/analytics','Portfolio Composition']] as const){await page.goto(origin+path);await expect(page.locator('main')).toContainText(text);}
 await expect(page.locator('.composition-stats')).toContainText('₹9,99,550.00');
 await expect(page.locator('.composition-stats')).toContainText('₹450.00');
 const reconciliation=await(await page.request.get(`${origin}/api/account/reconciliation`)).json();assert.equal(reconciliation.balanced,true);
 await page.goto(`${origin}/stocks/AAPL`);await page.getByRole('button',{name:/^Trade$/}).click();await page.locator('.zk-inputs input').first().fill('1.0000');await page.locator('.zk-btn-submit').click();await expect(page.locator('.zk-card')).toHaveCount(0);
 await page.goto(`${origin}/dashboard`);const usdRow=page.locator('tbody tr').filter({hasText:'AAPL'});await expect(usdRow.locator('td').nth(4)).toHaveText('₹12,450.00');
 await page.goto(`${origin}/notes`);await page.getByRole('button',{name:'New',exact:true}).click();await page.getByPlaceholder('Note title…').fill('Saved through React');await page.locator('.notes-editor-panel textarea').fill('Persistent UI note');await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('.notes-list')).toContainText('Saved through React');await page.reload();await expect(page.locator('.notes-list')).toContainText('Saved through React');
 await page.goto(`${origin}/dashboard`);await expect(page.locator('tbody')).toContainText('RELIANCE.NS');await page.waitForLoadState('networkidle');await page.screenshot({path:'/tmp/pern-dashboard.png',fullPage:true});
 assert.deepEqual(errors,[],'No React crashes on any retained route');assert.deepEqual(badResponses,[],'No API contract failures from retained pages');
 const logout=await page.request.post(`${origin}/api/auth/logout`,{headers});assert.equal(logout.status(),204);await page.reload();await expect(page).toHaveURL(/\/login$/);
 console.log('PASS: 10 retained routes; browser register/login/market buy; owned tools, alert/pending execution, analytics, logout; no browser or API errors');
} finally {await browser?.close();for(const child of processes.reverse())await stop(child);await h.close();}
