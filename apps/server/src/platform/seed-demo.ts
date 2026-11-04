import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {upgradeFiveYearDemo,seedFiveYearDemo} from '../modules/demo/five-year-upgrade.js';
import {prepareFiveYearHistory} from '../modules/demo/five-year.js';
import {upgradeDemo} from '../modules/demo/upgrade.js';
import {prepareDemoHistory} from '../modules/demo/history.js';
import { randomBytes,randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemo, DemoSeedError } from '../modules/demo/seed.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { readSchemaVersion } from './migrate.js';

async function main(): Promise<void> {
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    const config=loadConfig(process.env);
    if(config.nodeEnv==='production')throw new DemoSeedError('Demo seed is disabled in production');
    const provider=process.env.MARKET_PROVIDER??'yfinance';
    if(provider!=='fixture'&&provider!=='yfinance'&&provider!=='yahoo')throw new DemoSeedError('Unsupported demo market provider');
    const upgrade=process.argv.includes('--upgrade');
    const fiveYears=!process.argv.includes('--one-month');
    if(process.argv.slice(2).some(arg=>!['--upgrade','--five-years','--one-month'].includes(arg)))throw new DemoSeedError('Supported flags: --upgrade, --five-years or legacy --one-month');
    if(provider!=='yfinance')throw new DemoSeedError('Historical demo seeding requires the yfinance provider');
    if(upgrade&&!process.env.DEMO_UPGRADE_DATABASE_URL)throw new DemoSeedError('Explicit upgrade requires DEMO_UPGRADE_DATABASE_URL with owner maintenance privileges');
    pool=createPool(upgrade?process.env.DEMO_UPGRADE_DATABASE_URL!:config.databaseUrl);
    if(await readSchemaVersion(pool)!==config.expectedSchemaVersion)throw new DemoSeedError('Apply the current migrations before seeding the demo user');
    const password=process.env.DEMO_PASSWORD??randomBytes(18).toString('base64url');
    const url=new URL(process.env.YFINANCE_URL??'http://127.0.0.1:8000');
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new DemoSeedError('Invalid YFINANCE_URL');
    const historyUrl=new URL('/demo-history',url);if(fiveYears)historyUrl.searchParams.set('period','5y');
    const response=await fetch(historyUrl,{signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new DemoSeedError('Historical provider data unavailable; account left unchanged');
    const text=await response.text();if(text.length>(fiveYears?2000000:100000))throw new DemoSeedError('Historical provider response too large');
    const history=JSON.parse(text) as unknown;if(fiveYears)prepareFiveYearHistory(history);else prepareDemoHistory(history);
    const directory=process.env.DEMO_BACKUP_DIR??join(tmpdir(),'paper-demo-history');
    await mkdir(directory,{recursive:true,mode:0o700});
    const save=async(kind:string,value:unknown)=>{
      const path=join(directory,`${kind}-${randomUUID()}.json`);
      await writeFile(path,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
      console.log(`${kind} artifact: ${path}`);
    };
    if(upgrade&&fiveYears){
      let priorHistory:unknown;
      if(process.env.DEMO_PRIOR_HISTORY_PATH){
        const artifact=JSON.parse(await readFile(process.env.DEMO_PRIOR_HISTORY_PATH,'utf8')) as Record<string,unknown>;
        priorHistory=artifact.history??artifact;
      }
      if(!priorHistory&&!(await pool.query("SELECT 1 FROM demo_history_versions WHERE account_id=(SELECT id FROM accounts WHERE user_id='de000000-0000-4000-8000-000000000001') AND version>=3")).rowCount)throw new DemoSeedError('Set DEMO_PRIOR_HISTORY_PATH to the retained v2 source/backup artifact before upgrading');
      const result=await upgradeFiveYearDemo(pool,{history,priorHistory,nodeEnv:config.nodeEnv,backup:value=>save('demo-before-five-year-upgrade',value)});
      console.log(result.updated?`Five-year demo upgraded. Cash: INR ${result.cashBalance}`:'Five-year demo already exists; activity left unchanged.');return;
    }
    if(upgrade){
      const result=await upgradeDemo(pool,{history,nodeEnv:config.nodeEnv,backup:value=>save('demo-before-upgrade',value)});
      console.log(result.updated?`Demo history upgraded. Cash: INR ${result.cashBalance}`:'Demo history already upgraded; activity left unchanged.');
      return;
    }
    await save('demo-provider-history',history);
    const seed=fiveYears?seedFiveYearDemo:seedDemo;
    const result=await seed(pool,{password,nodeEnv:config.nodeEnv,provider,history});
    console.log(result.created?'Demo user created.':'Demo user already exists; password and activity left unchanged.');
    console.log('Username: demo');
    if(result.created)console.log(`Password: ${password}`);
  } catch(error) {
    console.error(error instanceof DemoSeedError?error.message:'Demo seed failed. Check historical provider availability, input validation and database access; incomplete writes are rolled back.');
    process.exitCode=1;
  } finally { await pool?.end(); }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
