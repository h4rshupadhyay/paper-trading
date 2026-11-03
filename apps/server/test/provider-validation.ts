import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { FixtureProvider, YahooProvider, type MarketProvider } from '../src/modules/market-data/provider.js';
import { discoverInstruments, readHistory, readQuote, refreshInstrument } from '../src/modules/market-data/service.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { submitOrder } from '../src/modules/trading/service.js';
import { reconcileAccount } from '../src/modules/accounts/reconciliation.js';
import { AppError } from '../src/platform/errors.js';
import { migrate } from '../src/platform/migrate.js';
import { createHarness } from './harness.js';

const regions = [
  { region:'US / Nasdaq',symbol:'AAPL',currency:'USD' },
  { region:'India / NSE',symbol:'RELIANCE.NS',currency:'INR' },
  { region:'UK / LSE',symbol:'VOD.L',currency:'GBP' },
  { region:'Europe / Germany sample',symbol:'SAP.DE',currency:'EUR' },
  { region:'Japan / Tokyo',symbol:'7203.T',currency:'JPY' },
  { region:'Hong Kong',symbol:'0700.HK',currency:'HKD' },
];

export type RegionEvidence = {
  region: string; symbol: string; currency: string; mode: 'live'|'simulated';
  tradable: boolean; price: string|null; fxRate: string|null; historyBars: number;
  orderResult: string; blockers: string[]; checkedAt: string;
  quoteObservedAt: string|null; quoteAgeSeconds: number|null; session: string|null;
  fxObservedAt: string|null; rawPrice: string|null; rawCurrency: string|null;
  exchange: string|null; multiplier: string|null;
};

/** Diagnostic only: provider/network access plus mutations confined to the caller's test DB. */
export async function validateProvider(pool: Pool, provider: MarketProvider): Promise<RegionEvidence[]> {
  if(process.env.NODE_ENV==='production') throw new Error('Validation probe is forbidden in production');
  const mode=provider.name==='fixture'?'simulated':'live';
  const name=`probe_${randomUUID().replaceAll('-','').slice(0,12)}`;
  const {user}=await registerUser(pool,{username:name,email:`${name}@example.invalid`,password:'unused-probe-password'},async()=> 'disabled-probe-login');
  // One bootstrap (six metadata calls), then quote/FX/history per region: <=23 Yahoo calls.
  const instruments=await discoverInstruments(pool,'',provider);
  const evidence:RegionEvidence[]=[];
  for(const region of regions){
    const item=instruments.find(value=>value.symbol===region.symbol);
    const row:RegionEvidence={...region,mode,tradable:false,price:null,fxRate:null,historyBars:0,orderResult:'NOT_ATTEMPTED',blockers:[],checkedAt:new Date().toISOString(),
      quoteObservedAt:null,quoteAgeSeconds:null,session:null,fxObservedAt:null,rawPrice:null,rawCurrency:null,exchange:item?.exchange??null,multiplier:item?.multiplier??null};
    if(mode==='live') row.blockers.push('LIVE_PROVIDER_NOT_ACCEPTED','ENTITLEMENTS_UNVERIFIED','CORPORATE_ACTION_COVERAGE_UNVERIFIED');
    if(!item){row.blockers.push('INSTRUMENT_UNAVAILABLE');evidence.push(row);continue;}
    row.tradable=item.tradable;
    await refreshInstrument(pool,item.id,provider);
    const {quote,unavailableReason}=await readQuote(pool,item.id);
    if(unavailableReason==='CORPORATE_ACTION_REVIEW')row.blockers.push('INSTRUMENT_PAUSED');
    row.checkedAt=new Date().toISOString();
    if(!quote) row.blockers.push('QUOTE_UNAVAILABLE');
    else {
      row.price=quote.price;row.rawPrice=quote.rawPrice;row.rawCurrency=quote.rawCurrency;
      row.quoteObservedAt=quote.observedAt;row.session=quote.session;
      row.quoteAgeSeconds=Math.round((Date.parse(row.checkedAt)-Date.parse(quote.observedAt))/1000);
      if(quote.quality==='stale') row.blockers.push('QUOTE_NOT_FRESH');
      if(quote.quality==='unavailable') row.blockers.push('QUOTE_UNAVAILABLE');
      if(quote.session!=='REGULAR') row.blockers.push('REGULAR_SESSION_UNCONFIRMED');
    }
    const fx=(await pool.query<{rate:string;observedAt:string;fresh:boolean}>(`SELECT rate::text,
      to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt",
      observed_at BETWEEN clock_timestamp()-interval '24 hours' AND clock_timestamp()+interval '5 seconds' AS fresh
      FROM latest_fx_rates WHERE currency=$1 AND provider=$2`,[item.currency,provider.name])).rows[0];
    if(fx){row.fxRate=fx.rate;row.fxObservedAt=fx.observedAt;if(!fx.fresh)row.blockers.push('FX_NOT_FRESH');}
    else row.blockers.push('FX_UNAVAILABLE');
    if(item.currency!==region.currency) row.blockers.push('CURRENCY_MISMATCH');
    row.historyBars=(await readHistory(pool,item.id,provider,{period:'3mo',interval:'1d'})).items.length;
    if(!row.historyBars)row.blockers.push('HISTORY_UNAVAILABLE');
    try {
      const result=await submitOrder(pool,user.id,{instrumentId:item.id,side:'BUY',type:'MARKET',quantity:'1'},randomUUID(),{refresh:async()=>{}});
      row.orderResult=result.order.status;
    } catch(error){
      if(!(error instanceof AppError))throw error;
      row.orderResult=error.code;
    }
    evidence.push(row);
  }
  if(!(await reconcileAccount(pool,user.id)).balanced)throw new Error('Probe account reconciliation failed');
  return evidence;
}

async function main(){
  if(process.env.NODE_ENV==='production')throw new Error('Validation probe is forbidden in production');
  // createHarness refuses every connection outside the dedicated disposable instance.
  const harness=await createHarness();
  try {
    await migrate(harness.ownerPool);
    const requests:{symbol:string;status:number|null;error:string|null}[]=[];
    const provider=new YahooProvider(async(url,options)=>{
      const symbol=decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1)??'');
      try {
        const response=await fetch(url,options);requests.push({symbol,status:response.status,error:null});return response;
      } catch(error){requests.push({symbol,status:null,error:error instanceof Error?error.name:'REQUEST_FAILED'});throw error;}
    });
    const live=await validateProvider(harness.appPool,provider);
    const fixtures=await validateProvider(harness.appPool,new FixtureProvider());
    const report={checkedAt:new Date().toISOString(),provider:'yahoo',decision:'NOT_ACCEPTED',
      scope:'Six representative equities only; Germany does not establish all European venue coverage.',
      live,fixtures,requests,
      remainingEvidence:['Exchange entitlements and permitted app usage','Timestamped regular-session and halt evidence','Complete corporate-action coverage and corrections','Regular-session probes across all six regions and held/order symbols'],
    };
    process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
    process.exitCode=live.some(row=>row.orderResult!=='INSTRUMENT_UNAVAILABLE'&&row.orderResult!=='NOT_ATTEMPTED')||fixtures.some(row=>row.orderResult!=='FILLED')?1:2;
  } finally {await harness.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:'Probe failed'}\n`);process.exitCode=1;});
}
