import { afterEach, expect, it } from 'vitest';
import { migrate } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';
import { FixtureProvider, type MarketProvider } from '../src/modules/market-data/provider.js';
import { discoverInstruments, refreshInstrument, readQuote } from '../src/modules/market-data/service.js';
import * as snapshots from '../src/modules/market-data/snapshot.js';

let db: TestHarness | undefined;
afterEach(async()=>{await db?.close();db=undefined});
async function setup(){
  db=await createHarness();await migrate(db.ownerPool);
  const base=new FixtureProvider();
  const item=(await discoverInstruments(db.appPool,'VOD.L',base))[0]!;
  return {pool:db.appPool,item,base};
}
const values={open:'123.5',dayHigh:'125',dayLow:'120',previousClose:'122',volume:'0',averageVolume:'9007199254740993',marketCap:'123456789',trailingPE:'-5.25',fiftyTwoWeekHigh:'160',fiftyTwoWeekLow:null};
it('stores one coherent snapshot with normalized price units and preserves it through failed refreshes',async()=>{
  const {pool,item,base}=await setup();
  const provider:MarketProvider={...base,name:'fixture',search:q=>base.search(q),quote:i=>base.quote(i),fx:c=>base.fx(c),history:i=>base.history(i),statistics:async()=>({symbol:'VOD.L',rawCurrency:'GBp',statistics:values,sector:'Telecom',industry:null,description:null})};
  await refreshInstrument(pool,item.id,provider);
  const quoteBefore=await readQuote(pool,item.id);
  await snapshots.refreshStatistics(pool,item.id,provider);
  const first=await snapshots.readMarketSnapshot(pool,item.id);
  expect(first.statistics).toMatchObject({open:'1.23500000',volume:'0',marketCap:'123456789.00000000',trailingPE:'-5.25000000',quality:'fresh',sector:'Telecom'});
  expect(await readQuote(pool,item.id)).toEqual(quoteBefore);
  // A successful response is not fetched again within 30 minutes.
  let failedCalls=0;
  provider.statistics=async()=>{failedCalls++;throw Error('provider down')};
  await snapshots.refreshStatistics(pool,item.id,provider);
  expect((await snapshots.readMarketSnapshot(pool,item.id)).statistics).toEqual(first.statistics);
  expect(failedCalls).toBe(0);
  await db!.ownerPool.query("UPDATE latest_instrument_statistics SET fetched_at=now()-interval '61 minutes'");
  await db!.ownerPool.query("UPDATE instruments SET statistics_attempted_at=now()-interval '61 seconds'");
  await snapshots.refreshStatistics(pool,item.id,provider);
  expect(failedCalls).toBe(1);
  const stale=(await snapshots.readMarketSnapshot(pool,item.id)).statistics!;
  expect(stale).toMatchObject({open:'1.23500000',quality:'stale'});
  expect(stale.fetchedAt).not.toEqual(first.statistics!.fetchedAt);
  const stored=(await pool.query('SELECT fetched_at FROM latest_instrument_statistics')).rows[0].fetched_at;
  expect(new Date(stale.fetchedAt).toISOString()).toEqual(stored.toISOString());
});
it('returns stored quotes while refresh is pending and keeps a partial statistics response coherent',async()=>{
  const {pool,item,base}=await setup();await refreshInstrument(pool,item.id,base);
  await db!.ownerPool.query("UPDATE latest_quotes SET fetched_at=now()-interval '20 seconds'");
  let release!:()=>void;let entered!:()=>void;
  const gate=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{entered=r});
  const provider:MarketProvider={name:'fixture',search:q=>base.search(q),fx:c=>base.fx(c),history:i=>base.history(i),quote:async i=>{entered();await gate;return base.quote(i)},statistics:async()=>({symbol:item.symbol,rawCurrency:'GBp',statistics:{...values,open:null},sector:null,industry:null,description:null})};
  try {
    const result=await snapshots.marketSnapshot(pool,item.id,provider);await started;
    expect(result.quote?.price).toBe('150.00000000');
  } finally {release();await snapshots.drainSnapshotRefreshes(pool)}
  expect((await snapshots.readMarketSnapshot(pool,item.id)).statistics).toMatchObject({open:null,previousClose:'1.22000000'});
});
it('rejects invalid statistics without overwriting storage and restricts runtime privileges',async()=>{
  const {pool,item,base}=await setup();
  const provider:MarketProvider={name:'fixture',search:q=>base.search(q),fx:c=>base.fx(c),history:i=>base.history(i),quote:i=>base.quote(i),statistics:async()=>({symbol:item.symbol,rawCurrency:'USD',statistics:values,sector:null,industry:null,description:null})};
  await snapshots.refreshStatistics(pool,item.id,provider);
  expect((await snapshots.readMarketSnapshot(pool,item.id)).statistics).toBeNull();
  await expect(pool.query('DELETE FROM latest_instrument_statistics')).rejects.toMatchObject({code:'42501'});
});
