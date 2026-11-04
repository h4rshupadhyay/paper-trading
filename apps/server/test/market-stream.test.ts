import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { migrate } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';
import * as market from '../src/modules/market-data/service.js';
import type { MarketProvider, ProviderQuote } from '../src/modules/market-data/provider.js';
let h:TestHarness;
let id:string;
beforeEach(async()=>{
  h=await createHarness();await migrate(h.ownerPool);
  id=(await h.appPool.query(`INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,provider)
    VALUES('STREAM','Stream','NMS','USD',1,'EQUITY',true,'yfinance') RETURNING id`)).rows[0].id;
});
it('confirms an identical whole-second HTTP fallback without rolling back the precise stream observation',async()=>{
  const precise=new Date(Date.now()-1500);precise.setMilliseconds(750);
  const whole=new Date(precise);whole.setMilliseconds(0);
  const value=tick({observedAt:precise.toISOString()});await market.ingestStreamQuote(h.appPool,id,value);
  await h.ownerPool.query("UPDATE latest_quotes SET fetched_at=clock_timestamp()-interval '61 seconds' WHERE instrument_id=$1",[id]);
  const provider:MarketProvider={name:'yfinance',search:async()=>[],history:async()=>[],quote:async()=>({...value,observedAt:whole.toISOString()}),fx:async()=>({rate:'83',observedAt:whole.toISOString()})};
  const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+11000);
  try{await market.refreshInstrument(h.appPool,id,provider);}finally{clock.mockRestore();}
  const confirmed=(await market.readQuote(h.appPool,id)).quote!;
  expect(confirmed.observedAt).toBe(precise.toISOString());expect(confirmed.quality).toBe('fresh');
  await h.ownerPool.query("UPDATE latest_quotes SET fetched_at=clock_timestamp()-interval '61 seconds' WHERE instrument_id=$1",[id]);
  provider.quote=async()=>({...value,rawPrice:'999',observedAt:whole.toISOString()});
  const later=vi.spyOn(Date,'now').mockReturnValue(Date.now()+22000);
  try{await market.refreshInstrument(h.appPool,id,provider);}finally{later.mockRestore();}
  const conflict=(await market.readQuote(h.appPool,id)).quote!;
  expect(conflict.price).toBe('123.45000000');expect(conflict.observedAt).toBe(precise.toISOString());expect(conflict.quality).toBe('stale');
});
afterEach(async()=>{await h?.close();});
const tick=(overrides:Partial<ProviderQuote>={}):ProviderQuote=>({rawPrice:'123.45',rawCurrency:'USD',observedAt:new Date(Date.now()-1000).toISOString(),session:'UNKNOWN',actionKey:'yfinance-raw',...overrides});
it('accepts a newer stream quote and never renews receipt time on replay, conflict or older delivery',async()=>{
  expect(market.ingestStreamQuote).toBeTypeOf('function');
  const quote=tick();expect(await market.ingestStreamQuote(h.appPool,id,quote)).toBe(true);
  const original=(await market.readQuote(h.appPool,id)).quote!;
  for(const value of [quote,{...quote,rawPrice:'999'},tick({observedAt:new Date(Date.now()-10000).toISOString()})]){
    expect(await market.ingestStreamQuote(h.appPool,id,value)).toBe(false);
    expect((await market.readQuote(h.appPool,id)).quote).toEqual(original);
  }
  expect(await market.ingestStreamQuote(h.appPool,id,tick({rawPrice:'124.25',observedAt:new Date().toISOString()}))).toBe(true);
  expect((await market.readQuote(h.appPool,id)).quote?.price).toBe('124.25000000');
});
it.each([{rawPrice:'NaN'},{rawPrice:'0'},{actionKey:'changed'},{session:'REGULAR'},
  {observedAt:'bad'},{observedAt:new Date(Date.now()+60000).toISOString()}])('rejects invalid stream input %#',async value=>{
  expect(await market.ingestStreamQuote(h.appPool,id,tick(value as Partial<ProviderQuote>))).toBe(false);
  expect((await market.readQuote(h.appPool,id)).quote).toBeNull();
});
it('normalizes explicit pence through SQL and pauses changed units',async()=>{
  await h.ownerPool.query("UPDATE instruments SET currency='GBP',multiplier=0.01 WHERE id=$1",[id]);
  expect(await market.ingestStreamQuote(h.appPool,id,tick({rawPrice:'123.45',rawCurrency:'GBp'}))).toBe(true);
  expect((await market.readQuote(h.appPool,id)).quote?.price).toBe('1.23450000');
  expect(await market.ingestStreamQuote(h.appPool,id,tick({rawCurrency:'GBP',observedAt:new Date().toISOString()}))).toBe(false);
  expect((await market.readQuote(h.appPool,id)).quality).toBe('unavailable');
});
it('suppresses HTTP quote polling only after an accepted stream tick while refreshing FX independently',async()=>{
  let calls=0,fxCalls=0;
  const provider:MarketProvider={name:'yfinance',search:async()=>[],history:async()=>[],quote:async()=>{calls++;return tick();},fx:async()=>{fxCalls++;return {rate:'83',observedAt:new Date().toISOString()};}};
  await market.refreshInstrument(h.appPool,id,provider);expect(calls).toBe(1);
  await market.refreshInstrument(h.appPool,id,provider);expect(calls).toBe(2);
  await market.ingestStreamQuote(h.appPool,id,tick({observedAt:new Date().toISOString()}));
  await market.refreshInstrument(h.appPool,id,provider);expect(calls).toBe(2);expect(fxCalls).toBeGreaterThan(2);
});
