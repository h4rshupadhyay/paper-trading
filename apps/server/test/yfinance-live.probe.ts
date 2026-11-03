import { randomUUID } from 'node:crypto';
import { createHarness } from './harness.js';
import { migrate } from '../src/platform/migrate.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { discoverInstruments, refreshInstrument, readQuote } from '../src/modules/market-data/service.js';
import { YfinanceProvider } from '../src/modules/market-data/yfinance-provider.js';
import { submitOrder } from '../src/modules/trading/service.js';
import { reconcileAccount } from '../src/modules/accounts/reconciliation.js';

if(process.env.NODE_ENV==='production')throw Error('Probe is forbidden in production');
const h=await createHarness();
try {
  await migrate(h.ownerPool);
  const {user}=await registerUser(h.appPool,{username:'yf_live_probe',email:'probe@example.invalid',password:'unused'},async()=> 'disabled-probe-login');
  const provider=new YfinanceProvider();
  const instruments=await discoverInstruments(h.appPool,'',provider),results=[];
  for(const symbol of ['AAPL','RELIANCE.NS','VOD.L','SAP.DE','7203.T','0700.HK']){
    const item=instruments.find(i=>i.symbol===symbol);
    if(!item){results.push({symbol,error:'INSTRUMENT_UNAVAILABLE'});continue;}
    try {
      await refreshInstrument(h.appPool,item.id,provider);
      const quote=(await readQuote(h.appPool,item.id)).quote;
      const {order}=await submitOrder(h.appPool,user.id,{instrumentId:item.id,side:'BUY',type:'MARKET',quantity:'1'},randomUUID(),{refresh:async()=>{}});
      results.push({symbol,currency:item.currency,quote,order});
    } catch(error){results.push({symbol,error:error instanceof Error?error.message:'PROBE_FAILED'});}
  }
  const reconciliation=await reconcileAccount(h.appPool,user.id);
  process.stdout.write(`${JSON.stringify({checkedAt:new Date().toISOString(),provider:'yfinance',paperTrades:true,results,reconciliation},null,2)}\n`);
  if(!reconciliation.balanced||results.some(row=>!('order'in row)||row.order.status!=='FILLED'))process.exitCode=1;
} finally {await h.close();}
