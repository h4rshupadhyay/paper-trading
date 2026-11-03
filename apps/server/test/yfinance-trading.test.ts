import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { FixtureProvider, type MarketProvider } from '../src/modules/market-data/provider.js';
import { discoverInstruments, readQuote, readFxRates, refreshInstrument } from '../src/modules/market-data/service.js';
import { submitOrder, evaluatePending } from '../src/modules/trading/service.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { reconcileAccount } from '../src/modules/accounts/reconciliation.js';
import { migrate } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';
import { YfinanceProvider } from '../src/modules/market-data/yfinance-provider.js';
import { createAlert, createEntry, entries, evaluateAlerts } from '../src/modules/user-tools/service.js';
import { readPortfolio } from '../src/modules/portfolio/service.js';

let h:TestHarness,userId:string;
const fixture=new FixtureProvider();
const observedAt=new Date(Date.now()-3*86400000).toISOString();
const provider:MarketProvider={name:'yfinance',search:q=>fixture.search(q),quote:async i=>({...await fixture.quote(i),observedAt,session:'UNKNOWN',actionKey:'yfinance-raw'}),
  fx:async c=>({...await fixture.fx(c),observedAt}),history:(i,o)=>fixture.history(i,o)};
const quiet={refresh:async()=>{}};
beforeEach(async()=>{
  h=await createHarness();await migrate(h.ownerPool);
  userId=(await registerUser(h.appPool,{username:'yf_trader',email:'yf@example.invalid',password:'unused'},async()=> 'test-hash')).user.id;
});
afterEach(async()=>{await h?.close();});
async function setup(symbol='AAPL'){
  const item=(await discoverInstruments(h.appPool,symbol,provider)).find(i=>i.symbol===symbol)!;
  await refreshInstrument(h.appPool,item.id,provider);return item;
}
const buy=(id:string)=>({instrumentId:id,side:'BUY',type:'MARKET',quantity:'1'});

it('shows recently confirmed yfinance quotes as fresh in the watchlist despite old source times and unknown sessions',async()=>{
  const item=await setup();
  const entry=await createEntry(h.appPool,userId,{instrumentId:item.id});
  expect(entry).toMatchObject({instrumentId:item.id,quality:'FRESH'});
  expect((await entries(h.appPool,userId,{after:null,limit:50})).items).toEqual([
    expect.objectContaining({id:entry.id,quality:'FRESH'}),
  ]);
});

it('shows yfinance quotes with future receipt times as stale in the watchlist',async()=>{
  const item=await setup();
  const entry=await createEntry(h.appPool,userId,{instrumentId:item.id});
  await h.ownerPool.query("UPDATE latest_quotes SET fetched_at=now()+interval '1 minute' WHERE instrument_id=$1",[item.id]);
  expect((await entries(h.appPool,userId,{after:null,limit:50})).items).toEqual([
    expect.objectContaining({id:entry.id,quality:'STALE'}),
  ]);
});

it('expires recently confirmed yfinance watchlist quotes when their receipt becomes too old',async()=>{
  const item=await setup();
  const entry=await createEntry(h.appPool,userId,{instrumentId:item.id});
  expect(entry.quality).toBe('FRESH');
  await h.ownerPool.query("UPDATE latest_quotes SET fetched_at=now()-interval '61 seconds' WHERE instrument_id=$1",[item.id]);
  expect((await entries(h.appPool,userId,{after:null,limit:50})).items).toEqual([
    expect.objectContaining({id:entry.id,quality:'STALE'}),
  ]);
});

it('keeps future observations and missing yfinance quotes unavailable for a fresh watchlist price',async()=>{
  const item=await setup();
  const entry=await createEntry(h.appPool,userId,{instrumentId:item.id});
  await h.ownerPool.query("UPDATE latest_quotes SET observed_at=now()+interval '1 minute' WHERE instrument_id=$1",[item.id]);
  expect((await entries(h.appPool,userId,{after:null,limit:50})).items).toEqual([
    expect.objectContaining({id:entry.id,quality:'STALE'}),
  ]);
  await h.ownerPool.query('DELETE FROM latest_quotes WHERE instrument_id=$1',[item.id]);
  expect((await entries(h.appPool,userId,{after:null,limit:50})).items).toEqual([
    expect.objectContaining({id:entry.id,price:null,quality:'UNAVAILABLE'}),
  ]);
});

it.each(['fixture','yahoo'])('retains source-age and session quality rules for %s watchlist quotes',async name=>{
  const strictProvider:MarketProvider={...provider,name};
  const item=(await discoverInstruments(h.appPool,'AAPL',strictProvider))[0]!;
  await refreshInstrument(h.appPool,item.id,strictProvider);
  const entry=await createEntry(h.appPool,userId,{instrumentId:item.id});
  expect(entry.quality).toBe('STALE');
  await h.ownerPool.query("UPDATE latest_quotes SET observed_at=now() WHERE instrument_id=$1",[item.id]);
  expect((await entries(h.appPool,userId,{after:null,limit:50})).items).toEqual([
    expect.objectContaining({id:entry.id,quality:'UNAVAILABLE'}),
  ]);
  await h.ownerPool.query("UPDATE latest_quotes SET session='CLOSED' WHERE instrument_id=$1",[item.id]);
  expect((await entries(h.appPool,userId,{after:null,limit:50})).items).toEqual([
    expect.objectContaining({id:entry.id,quality:'CLOSED'}),
  ]);
});

it('fills at yfinance observations across six currencies despite old source times and unknown sessions',async()=>{
  const samples=['AAPL','RELIANCE.NS','VOD.L','SAP.DE','7203.T','0700.HK'];
  const settlements=['12450.00','150.00','15750.00','13500.00','82.50','1590.00'];
  for(const [index,symbol] of samples.entries()){
    const item=await setup(symbol);expect(item.tradable).toBe(true);
    const result=await submitOrder(h.appPool,userId,buy(item.id),randomUUID(),quiet);
    expect(result.order).toMatchObject({status:'FILLED',executionPrice:'150.00000000',baseSettlement:settlements[index]});
    const quote=await readQuote(h.appPool,item.id);expect(quote.quality).toBe('fresh');expect(quote.quote?.observedAt).toBe(observedAt);
  }
  expect((await readFxRates(h.appPool,provider)).items.every(row=>row.quality==='fresh')).toBe(true);
  expect((await reconcileAccount(h.appPool,userId)).balanced).toBe(true);
  expect((await readPortfolio(h.appPool,userId)).quality).toBe('fresh');
});
it('reconfirms an identical yfinance observation without changing its source time or accepting conflicting prices',async()=>{
  const item=await setup();
  await h.ownerPool.query("UPDATE latest_quotes SET fetched_at=now()-interval '61 seconds' WHERE instrument_id=$1",[item.id]);
  await h.ownerPool.query("UPDATE latest_fx_rates SET fetched_at=now()-interval '25 hours'");
  await refreshInstrument(h.appPool,item.id,provider);
  expect((await readQuote(h.appPool,item.id)).quality).toBe('fresh');
  expect((await submitOrder(h.appPool,userId,buy(item.id),randomUUID(),quiet)).order.status).toBe('FILLED');
  await h.ownerPool.query("UPDATE latest_quotes SET fetched_at=now()-interval '61 seconds' WHERE instrument_id=$1",[item.id]);
  const changed:MarketProvider={...provider,quote:async i=>({...await provider.quote(i),rawPrice:'999'})};
  await refreshInstrument(h.appPool,item.id,changed);
  expect((await readQuote(h.appPool,item.id)).quote?.price).toBe('150.00000000');
  await expect(submitOrder(h.appPool,userId,buy(item.id),randomUUID(),quiet)).rejects.toMatchObject({code:'MARKET_DATA_UNAVAILABLE'});
});
it('blocks missing, future, expired-receipt and provider-mismatched observations without synthetic fallback',async()=>{
  const item=await setup();
  await h.ownerPool.query("UPDATE latest_quotes SET fetched_at=now()-interval '61 seconds' WHERE instrument_id=$1",[item.id]);
  await expect(submitOrder(h.appPool,userId,buy(item.id),randomUUID(),quiet)).rejects.toMatchObject({code:'MARKET_DATA_UNAVAILABLE'});
  await refreshInstrument(h.appPool,item.id,provider);
  await h.ownerPool.query("UPDATE latest_fx_rates SET fetched_at=now()-interval '25 hours' WHERE currency='USD'");
  await expect(submitOrder(h.appPool,userId,buy(item.id),randomUUID(),quiet)).rejects.toMatchObject({code:'MARKET_DATA_UNAVAILABLE'});
  await refreshInstrument(h.appPool,item.id,provider);
  await h.ownerPool.query("UPDATE latest_quotes SET observed_at=now()+interval '6 seconds' WHERE instrument_id=$1",[item.id]);
  await expect(submitOrder(h.appPool,userId,buy(item.id),randomUUID(),quiet)).rejects.toMatchObject({code:'MARKET_DATA_UNAVAILABLE'});
  await h.ownerPool.query("DELETE FROM latest_quotes WHERE instrument_id=$1",[item.id]);
  await expect(submitOrder(h.appPool,userId,buy(item.id),randomUUID(),quiet)).rejects.toMatchObject({code:'MARKET_DATA_UNAVAILABLE'});
  const index=await setup('^GSPC');expect(index.tradable).toBe(false);
  await expect(submitOrder(h.appPool,userId,buy(index.id),randomUUID(),quiet)).rejects.toMatchObject({code:'INSTRUMENT_UNAVAILABLE'});
});
it('pauses yfinance instruments when a refreshed response changes currency metadata',async()=>{
  const item=await setup();
  const changed=new YfinanceProvider('http://market-data:8000',async()=>new Response(JSON.stringify({instrument:{...item,currency:'GBP',multiplier:'1'},quote:{rawPrice:'150',rawCurrency:'GBP',observedAt,session:'UNKNOWN',actionKey:'yfinance-raw'}})));
  await refreshInstrument(h.appPool,item.id,changed);
  expect((await readQuote(h.appPool,item.id)).unavailableReason).toBe('CORPORATE_ACTION_REVIEW');
  await expect(submitOrder(h.appPool,userId,buy(item.id),randomUUID(),quiet)).rejects.toMatchObject({code:'INSTRUMENT_UNAVAILABLE'});
});
it('evaluates one-shot alerts against the same latest-confirmed yfinance observations',async()=>{
  const item=await setup('RELIANCE.NS');
  await createAlert(h.appPool,userId,{instrumentId:item.id,condition:'ABOVE',targetPrice:'100'});
  await evaluateAlerts(h.appPool);
  expect((await h.appPool.query('SELECT count(*)::int AS count FROM notifications WHERE user_id=$1',[userId])).rows[0]!.count).toBe(1);
});
it('applies the same yfinance policy to pending orders and keeps generic Yahoo sources view-only',async()=>{
  const item=await setup('RELIANCE.NS');
  const result=await submitOrder(h.appPool,userId,{...buy(item.id),type:'LIMIT',limitPrice:'151'},randomUUID(),quiet);
  await evaluatePending(h.appPool);
  expect((await h.appPool.query('SELECT status FROM orders WHERE id=$1',[result.order.id])).rows[0]!.status).toBe('FILLED');
  const other=(await discoverInstruments(h.appPool,'AAPL',{...provider,name:'yahoo'}))[0]!;expect(other.tradable).toBe(false);
  await expect(submitOrder(h.appPool,userId,buy(other.id),randomUUID(),quiet)).rejects.toMatchObject({code:'INSTRUMENT_UNAVAILABLE'});
});
