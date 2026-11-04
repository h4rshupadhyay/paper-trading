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
 launch(['frontend/node_modules/vite/bin/vite.js','preview','frontend','--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_API_TARGET:`http://127.0.0.1:${apiPort}`});
 await expect.poll(async()=>{try{return(await fetch(`${origin}/api/health/ready`)).status}catch{return 0}},{timeout:15000}).toBe(200);
 browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE??'/usr/bin/google-chrome',args:['--no-sandbox'],headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`${origin}/register`);await page.getByLabel('Username',{exact:true}).fill('browser_trader');await page.getByLabel('Email').fill('browser@example.com');await page.getByLabel('Password',{exact:true}).fill('browser secure password');await page.getByLabel('Confirm Password').fill('browser secure password');await page.getByRole('button',{name:'Create Account'}).click();await expect(page.getByText('Account created!')).toBeVisible();
 await expect(page).toHaveURL(/\/login$/);await page.getByLabel('Username',{exact:true}).fill('browser_trader');await page.getByLabel('Password',{exact:true}).fill('browser secure password');await page.getByRole('button',{name:'Sign In'}).click();await expect(page).toHaveURL(/\/dashboard$/);
 await expect(page.getByRole('heading',{name:'Dashboard',exact:true})).toBeVisible();
 const badResponses:string[]=[];page.on('response',response=>{if(response.url().includes('/api/')&&response.status()>=400)badResponses.push(`${response.status()} ${response.url()}`)});
 // React Router retains the current page during a lazy client-side transition.
 let releaseNotes!:()=>void;let notesRequested=false;
 const notesReady=new Promise<void>(resolve=>{releaseNotes=resolve;});
 await page.route('**/assets/Notes-*.js',async route=>{notesRequested=true;await notesReady;await route.continue();});
 try {
  await page.getByRole('link',{name:'Notes',exact:true}).click();
  await expect.poll(()=>notesRequested).toBe(true);
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Dashboard',exact:true})).toBeVisible();
 } finally {releaseNotes();}
 await expect(page.locator('main')).toContainText('My Notes');
 await page.unroute('**/assets/Notes-*.js');
 // An initial deep link has no previous page and shows the loading fallback.
 let releaseOrders!:()=>void;let ordersRequested=false;
 const ordersReady=new Promise<void>(resolve=>{releaseOrders=resolve;});
 await page.route('**/assets/Orders-*.js',async route=>{ordersRequested=true;await ordersReady;await route.continue();});
 const ordersNavigation=page.goto(`${origin}/orders`);
 try {
  await expect.poll(()=>ordersRequested).toBe(true);
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.getByRole('status',{name:'Loading page',exact:true})).toBeVisible();
 } finally {releaseOrders();await ordersNavigation;}
 await expect(page.locator('main')).toBeVisible();
 await page.unroute('**/assets/Orders-*.js');
 for(const path of ['/dashboard','/stocks/RELIANCE.NS','/orders','/watchlist','/pending-orders','/alerts','/notes','/analytics']) {
  await page.goto(origin+path);await expect(page.locator('main')).toBeVisible();await expect(page.locator('.splash')).toHaveCount(0);await page.waitForLoadState('networkidle');
 }
 await page.goto(`${origin}/stocks/RELIANCE.NS`);await expect(page.locator('.stock-ticker')).toHaveText('RELIANCE.NS');
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
 const alert=await page.request.post(`${origin}/api/alerts`,{headers,data:{instrumentId,condition:'ABOVE',targetPrice:'100'}});assert.equal(alert.status(),201);
 const createdAlert=(await alert.json()).alert;
 await evaluateAlerts(h.appPool);await sampleSnapshots(h.appPool);
 const pending=await page.request.post(`${origin}/api/orders`,{headers:{...headers,'Idempotency-Key':'browser-pending-01'},data:{instrumentId,side:'BUY',type:'STOP_LIMIT',quantity:'1',stopPrice:'100',limitPrice:'200'}});assert.equal(pending.status(),201);await evaluatePending(h.appPool);
 for(const [path,text] of [['/watchlist','RELIANCE.NS'],['/notes','Browser journal'],['/alerts','RELIANCE.NS'],['/pending-orders','FILLED'],['/orders','FILLED'],['/analytics','Portfolio Composition']] as const){await page.goto(origin+path);await expect(page.locator('main')).toContainText(text);}
 await expect(page.locator('.composition-stats')).toContainText('₹9,99,550.00');
 await expect(page.locator('.composition-stats')).toContainText('₹450.00');
 const reconciliation=await(await page.request.get(`${origin}/api/account/reconciliation`)).json();assert.equal(reconciliation.balanced,true);
 await page.goto(`${origin}/stocks/AAPL`);await page.getByRole('button',{name:/^Trade$/}).click();await page.locator('.zk-inputs input').first().fill('1.0000');await page.locator('.zk-btn-submit').click();await expect(page.locator('.zk-card')).toHaveCount(0);
 await page.goto(`${origin}/dashboard`);const usdRow=page.locator('tbody tr').filter({hasText:'AAPL'});await expect(usdRow.locator('td').nth(4)).toHaveText('₹12,450.00');
 const reviewFailures:unknown[]=[];
 await page.goto(`${origin}/alerts`);
 const storedAlert=(await h.ownerPool.query('SELECT created_at FROM price_alerts WHERE id=$1',[createdAlert.id])).rows[0];
 const createdDate=await page.evaluate(value=>new Date(value).toLocaleDateString(),storedAlert.created_at.toISOString());
 try {await expect(page.locator('tbody tr').filter({hasText:'RELIANCE.NS'}).locator('td').nth(4)).toHaveText(createdDate);}catch(error){reviewFailures.push(error);}
 // Pending rows must show both directions from the resource API's side field.
 const pendingSell=await page.request.post(`${origin}/api/orders`,{headers:{...headers,'Idempotency-Key':'browser-pending-sell-label'},data:{instrumentId,side:'SELL',type:'LIMIT',quantity:'1',limitPrice:'200'}});
 assert.equal(pendingSell.status(),201);
 await page.goto(`${origin}/pending-orders`);
 const sellRow=page.locator('tbody tr').filter({hasText:'RELIANCE.NS'});
 try {await expect(sellRow.locator('td').nth(1).locator('.type-badge.neg')).toHaveText('SELL');}catch(error){reviewFailures.push(error);}
 const pendingSellId=(await pendingSell.json()).order.id;
 assert.equal((await page.request.post(`${origin}/api/orders/${pendingSellId}/cancel`,{headers})).status(),200);
 await page.goto(`${origin}/stocks/AAPL`);
 try {await expect(page.locator('.price-chart .recharts-yAxis').first()).toContainText('₹12,');}catch(error){reviewFailures.push(error);}
 const gap=await page.request.post(`${origin}/api/orders`,{headers:{...headers,'Idempotency-Key':'browser-gap-cancel'},data:{instrumentId,side:'BUY',type:'STOP_LIMIT',quantity:'1',stopPrice:'100',limitPrice:'90'}});
 assert.equal(gap.status(),201);const gapId=(await gap.json()).order.id;await evaluatePending(h.appPool);
 await page.goto(`${origin}/pending-orders`);await page.getByRole('button',{name:'TRIGGERED',exact:true}).click();
 try {
  const row=page.locator('tbody tr').filter({hasText:'RELIANCE.NS'});
  await expect(row.locator('td').nth(1).locator('.type-badge.pos')).toHaveText('BUY');
  await expect(row.getByTitle('Cancel order')).toBeVisible();await row.getByTitle('Cancel order').click();
  await expect(row).toHaveCount(0);
  assert.equal((await(await page.request.get(`${origin}/api/orders/${gapId}`)).json()).order.status,'CANCELLED');
 }catch(error){reviewFailures.push(error);}
 if(reviewFailures.length)throw new AggregateError(reviewFailures,'Review regressions: pending order sides, converted chart axis and triggered-order cancellation');
 await page.goto(`${origin}/notes`);await page.getByRole('button',{name:'New',exact:true}).click();await page.getByPlaceholder('Note title…').fill('Saved through React');await page.locator('.notes-editor-panel textarea').fill('Persistent UI note');await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('.notes-list')).toContainText('Saved through React');await page.reload();await expect(page.locator('.notes-list')).toContainText('Saved through React');
 await page.goto(`${origin}/dashboard`);await expect(page.locator('tbody')).toContainText('RELIANCE.NS');await page.waitForLoadState('networkidle');await page.screenshot({path:'/tmp/pern-dashboard.png',fullPage:true});
 // Both mark-all controls must traverse notification pages and honor the 100-ID write limit.
 const readBatchSizes:number[]=[];
 page.on('request',request=>{if(request.method()==='POST'&&request.url()===`${origin}/api/notifications/read`)readBatchSizes.push(request.postDataJSON().ids.length);});
 const seedNotifications=async(count:number)=>h.ownerPool.query(`INSERT INTO notifications(user_id,message)
   SELECT u.id,'Batch notification '||n FROM users u CROSS JOIN generate_series(1,$1::int) n WHERE u.username='browser_trader'`,[count]);
 const unreadCount=async()=>Number((await h.ownerPool.query(`SELECT count(*) FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.username='browser_trader' AND n.read_at IS NULL`)).rows[0].count);
 await seedNotifications(205);
 const pageUnread=await unreadCount();
 await page.goto(`${origin}/alerts`);await expect(page.locator('.notif-count-badge')).toHaveText(`${pageUnread} unread`);
 await page.locator('main').getByRole('button',{name:'Mark all read',exact:true}).click();
 await expect.poll(unreadCount).toBe(0);await expect(page.locator('.notif-count-badge')).toHaveCount(0);
 await seedNotifications(101);
 await page.goto(`${origin}/dashboard`);await page.getByTitle('Notifications',{exact:true}).click();
 await expect(page.locator('.notif-dropdown-item')).toHaveCount(8);
 await page.locator('.notif-dropdown').getByRole('button',{name:'Mark all read',exact:true}).click();
 await expect.poll(unreadCount).toBe(0);await expect(page.locator('.notif-dropdown-empty')).toHaveText('No unread notifications');
 assert.ok(readBatchSizes.length>=5);assert.ok(readBatchSizes.every(size=>size>0&&size<=100));
 assert.deepEqual(errors,[],'No React crashes on any retained route');assert.deepEqual(badResponses,[],'No API contract failures from retained pages');
 // Shared styling must keep controls reachable on small screens in both themes.
 for(const theme of ['dark','light']) {
  const target=theme==='light'?'Switch to light mode':'Switch to dark mode';
  if(await page.getByTitle(target,{exact:true}).count())await page.getByTitle(target,{exact:true}).click();
  for(const width of [1440,900,390]) {
   await page.setViewportSize({width,height:1000});
   for(const path of ['/dashboard','/stocks/AAPL','/pending-orders','/notes','/alerts','/analytics','/watchlist','/orders']) {
    await page.goto(origin+path);await page.waitForLoadState('networkidle');
    if(process.env.UI_REVIEW_DIR)await page.screenshot({path:`${process.env.UI_REVIEW_DIR}/${theme}-${width}-${path.slice(1).replaceAll('/','-')}.png`,fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${path}: no page overflow at ${width}px in ${theme}`);
    for(const title of ['Notifications','Change region',theme==='light'?'Switch to dark mode':'Switch to light mode']) {
     const bounds=await page.getByTitle(title,{exact:true}).boundingBox();
     assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width,`${title} stays reachable at ${width}px in ${theme}`);
    }
    await expect(page.locator('.sidebar').getByRole('link',{name:'Dashboard',exact:true})).toHaveCount(1);
    await expect(page.getByRole('button',{name:'Logout',exact:true})).toBeVisible();
    if(path==='/stocks/AAPL'&&width===390) {
     await page.getByRole('button',{name:'Trade',exact:true}).click();
     const modal=await page.locator('.zk-card').boundingBox();
     assert.ok(modal&&modal.x>=0&&modal.x+modal.width<=width,'Mobile order form fits the viewport');
     await expect(page.getByLabel('Qty.',{exact:true})).toBeVisible();
     const side=page.getByRole('checkbox',{name:'Buy order',exact:true});
     await side.focus();await side.press('Space');await expect(page.locator('.zk-side-label')).toHaveText('Sell');
     await side.press('Space');await expect(page.locator('.zk-side-label')).toHaveText('Buy');
     if(process.env.UI_REVIEW_DIR)await page.screenshot({path:`${process.env.UI_REVIEW_DIR}/${theme}-390-order-form.png`,fullPage:true});
     await page.getByRole('button',{name:'Cancel',exact:true}).click();
    }
   }
  }
  await page.setViewportSize({width:667,height:375});await page.goto(origin+'/dashboard');
  await page.getByRole('button',{name:'Logout',exact:true}).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button',{name:'Logout',exact:true})).toBeInViewport();
  await page.locator('.sidebar').getByRole('link',{name:'Dashboard',exact:true}).scrollIntoViewIfNeeded();
  await expect(page.locator('.sidebar').getByRole('link',{name:'Dashboard',exact:true})).toBeInViewport();
  // A string expression avoids the TS runner's function-name helper leaking into browser code.
  const contrast=await page.evaluate<Array<{fg:string;bg:string;ratio:number}>>(`(() => {
   const styles=getComputedStyle(document.documentElement);
   const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');
   const luminance=(token)=>{context.fillStyle=styles.getPropertyValue(token).trim();context.fillRect(0,0,1,1);const rgb=context.getImageData(0,0,1,1).data;const channel=(index)=>{const c=rgb[index]/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;};return 0.2126*channel(0)+0.7152*channel(1)+0.0722*channel(2);};
   const text=['--text','--text-sub','--text-muted','--brand','--green','--red','--yellow'].flatMap(fg=>['--bg','--card-bg','--sidebar-bg','--input-bg'].map(bg=>{const a=luminance(fg),b=luminance(bg);return {fg,bg,ratio:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};}));
   const white=1;
   return text.concat(['--button-bg','--button-hover','--success-fill','--danger-fill','--warning-fill'].map(bg=>({fg:'white',bg,ratio:(white+0.05)/(luminance(bg)+0.05)})));
  })()`);
  for(const item of contrast)assert.ok(item.ratio>=4.5,`${theme} ${item.fg} on ${item.bg} meets text contrast: ${item.ratio}`);
 }
 await page.setViewportSize({width:1440,height:1000});
 assert.deepEqual(errors,[],'No React crashes during theme and responsive checks');
 // Advance only the browser clock: sessions and provider fixtures remain valid server-side.
 const fxObservedAt=new Date(Date.now()-86400000+30000).toISOString();let fxOutage=false;
 await page.route('**/api/fx-rates',async route=>{
  if(fxOutage){await route.abort();return;}
  await route.fulfill({json:{items:[{currency:'USD',rate:'83',quality:'fresh',provider:'fixture',observedAt:fxObservedAt}],baseCurrency:'INR'}});
 });
 await page.clock.install();
 await page.goto(`${origin}/stocks/AAPL`);await expect(page.locator('.stock-price')).toHaveText('₹12,450.00');
 fxOutage=true;await page.clock.fastForward(120000);
 await expect(page.locator('.stock-price')).toHaveText('₹—');
 await expect(page.locator('[role="status"]').filter({hasText:'Currency conversion'})).toContainText('unavailable');
 const logout=await page.request.post(`${origin}/api/auth/logout`,{headers});assert.equal(logout.status(),204);await page.reload();await expect(page).toHaveURL(/\/login$/);
 if(process.env.UI_REVIEW_DIR)for(const theme of ['dark','light']) {
  await page.evaluate(value=>localStorage.setItem('theme',value),theme);
  for(const width of [1440,390])for(const path of ['/login','/register']) {
   await page.setViewportSize({width,height:1000});await page.goto(origin+path);await page.waitForLoadState('networkidle');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Authentication page fits');
   await page.screenshot({path:`${process.env.UI_REVIEW_DIR}/${theme}-${width}-${path.slice(1)}.png`,fullPage:true});
   await expect(page.getByRole('heading',{level:1})).toBeVisible();
  }
 }
 console.log('PASS: 10 production routes; lazy navigation; register/login/market buy; owned tools, alert dates, BUY/SELL labels, both bulk notification controls, analytics, FX expiry and logout; responsive controls at 1440/900/390px in both themes, text contrast and keyboard order switch; no browser or API errors');
} finally {await browser?.close();for(const child of processes.reverse())await stop(child);await h.close();}
