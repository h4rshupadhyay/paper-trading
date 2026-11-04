import {spawn,type ChildProcess} from 'node:child_process';
import {createServer as httpServer} from 'node:http';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {createHarness} from './harness.js';
import {migrate} from '../src/platform/migrate.js';
import {ingestStreamQuote} from '../src/modules/market-data/service.js';
import {createEntry} from '../src/modules/user-tools/service.js';
import {submitOrder} from '../src/modules/trading/service.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
async function freePort(){const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('No port');await new Promise<void>(r=>server.close(()=>r()));return address.port;}
async function stop(child:ChildProcess){if(child.exitCode!=null||child.signalCode!=null)return;const closed=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);await closed;clearTimeout(timer);}
const h=await createHarness(),processes:ChildProcess[]=[];
let browser;
const instrument={symbol:'AAPL',name:'Apple Inc.',exchange:'NMS',currency:'USD',multiplier:'1',kind:'EQUITY',tradable:true,unavailableReason:null};
let price='200',observedAt=new Date(Date.now()-10000).toISOString();
const bridge=httpServer((request,response)=>{
  const url=new URL(request.url!,'http://market-data');
  const data=url.pathname==='/search'?{items:url.searchParams.get('q')?.startsWith('^')?[]:[instrument]}:
    url.pathname==='/quote'?{instrument,quote:{rawPrice:price,rawCurrency:'USD',observedAt,session:'UNKNOWN',actionKey:'yfinance-raw'}}:
    url.pathname==='/fx'?{currency:url.searchParams.get('currency'),rate:url.searchParams.get('currency')==='USD'?'83':'1',observedAt}:
    {instrument,items:[{observedAt,open:'199',high:'201',low:'198',close:'200',volume:'123'}]};
  response.setHeader('Content-Type','application/json');response.end(JSON.stringify(data));
});
try{
  await migrate(h.ownerPool);await new Promise<void>(r=>bridge.listen(0,'127.0.0.1',r));
  const address=bridge.address();if(!address||typeof address==='string')throw Error('No bridge');
  const apiPort=await freePort(),webPort=await freePort(),origin=`http://127.0.0.1:${webPort}`;
  const db=new URL('postgresql://127.0.0.1:55439');db.username=String(h.appPool.options.user);db.password=String(h.appPool.options.password);db.pathname=String(h.appPool.options.database);
  const launch=(args:string[],env:NodeJS.ProcessEnv)=>{const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,...env},stdio:['ignore','ignore','pipe']});processes.push(child);return child;};
  launch(['apps/server/dist/src/api.js'],{NODE_ENV:'test',PORT:String(apiPort),DATABASE_URL:db.href,PUBLIC_ORIGIN:origin,CSRF_SECRET:'streaming browser test secret at least32bytes',MARKET_PROVIDER:'yfinance',YFINANCE_URL:`http://127.0.0.1:${address.port}`});
  launch(['frontend/node_modules/vite/bin/vite.js','preview','frontend','--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_API_TARGET:`http://127.0.0.1:${apiPort}`});
  await expect.poll(async()=>{try{return(await fetch(`${origin}/api/health/ready`)).status}catch{return 0}},{timeout:15000}).toBe(200);
  browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];
  let portfolioReads=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/portfolio')portfolioReads++;});
  await page.addInitScript(()=>localStorage.setItem('region','US'));page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${origin}/register`);await page.getByLabel('Username',{exact:true}).fill('stream_browser');await page.getByLabel('Email').fill('stream-browser@example.com');await page.getByLabel('Password',{exact:true}).fill('stream browser password');await page.getByLabel('Confirm Password').fill('stream browser password');await page.getByRole('button',{name:'Create Account'}).click();
  await expect(page).toHaveURL(/\/login$/);await page.getByLabel('Username',{exact:true}).fill('stream_browser');await page.getByLabel('Password',{exact:true}).fill('stream browser password');await page.getByRole('button',{name:'Sign In'}).click();await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(`${origin}/stocks/AAPL`);await expect(page.locator('.stock-price')).toContainText('$200.00');
  const id=(await h.appPool.query("SELECT id FROM instruments WHERE symbol='AAPL'")).rows[0].id;
  const userId=(await h.appPool.query("SELECT id FROM users WHERE username='stream_browser'")).rows[0].id;
  await createEntry(h.appPool,userId,{instrumentId:id});
  await submitOrder(h.appPool,userId,{instrumentId:id,side:'BUY',type:'MARKET',quantity:'1'},randomUUID(),{refresh:async()=>{}});
  const push=async(value:string)=>{price=value;observedAt=new Date().toISOString();assert.equal(await ingestStreamQuote(h.appPool,id,{rawPrice:price,rawCurrency:'USD',observedAt,session:'UNKNOWN',actionKey:'yfinance-raw'}),true);};
  await push('201.25');await expect(page.locator('.stock-price')).toContainText('$201.25');
  await page.getByRole('button',{name:/^Trade$/}).click();await page.getByLabel('Qty.',{exact:true}).fill('3');
  await push('202.50');await expect(page.locator('.zk-header-price')).toHaveText('$202.50');await expect(page.getByLabel('Qty.',{exact:true})).toHaveValue('3');await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.goto(`${origin}/watchlist`);const watched=page.locator('tbody tr').filter({hasText:'AAPL'});await expect(watched).toContainText('$202.50');
  await push('203.75');await expect(watched).toContainText('$203.75');
  await page.goto(`${origin}/dashboard`);const holding=page.locator('tbody tr').filter({hasText:'AAPL'});await expect(holding.locator('td').nth(3)).toHaveText('$203.75');
  await push('204.50');await expect(holding.locator('td').nth(3)).toHaveText('$204.50');
  const reads=portfolioReads;
  for(let index=0;index<5;index++)await push('204.50');
  await page.waitForTimeout(1200);assert.equal(portfolioReads,reads,'unchanged prices must not cause portfolio GETs');
  await page.evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));");
  await push('205.25');
  await page.evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));");
  await expect(holding.locator('td').nth(3)).toHaveText('$205.25');
  assert.deepEqual(errors,[]);
  console.log('PASS: authenticated SSE updates stock, trade estimate without resetting quantity, watchlist and SQL-valued portfolio; visibility reconnect restores latest quote');
}finally{
  await browser?.close();for(const child of processes.reverse())await stop(child);
  bridge.closeAllConnections();await new Promise<void>(r=>bridge.close(()=>r()));await h.close();
}
