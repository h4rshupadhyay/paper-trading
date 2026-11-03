import { afterEach, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './harness.js';
import { migrate } from '../src/platform/migrate.js';
import { FixtureProvider, type MarketProvider } from '../src/modules/market-data/provider.js';
import { validateProvider } from './provider-validation.js';

let db: TestHarness | undefined;
afterEach(async () => { await db?.close(); db=undefined; });

it('proves fixture fills and live view-only rejection separately in all six regions', async () => {
  db=await createHarness(); await migrate(db.ownerPool);
  const fixture=new FixtureProvider();
  const simulated=await validateProvider(db.appPool,fixture);
  expect(simulated.map(row=>row.currency)).toEqual(['USD','INR','GBP','EUR','JPY','HKD']);
  expect(simulated.every(row=>row.mode==='simulated'&&row.orderResult==='FILLED')).toBe(true);
  expect(simulated.map(row=>row.price)).toEqual(Array(6).fill('150.00000000'));
  expect(simulated.map(row=>row.fxRate)).toEqual(['83.000000000000','1.000000000000','105.000000000000','90.000000000000','0.550000000000','10.600000000000']);
  // Even a source advertising fresh quotes/tradability cannot bypass live acceptance.
  const unvalidated:MarketProvider={name:'unvalidated-live',search:q=>fixture.search(q),quote:i=>fixture.quote(i),fx:c=>fixture.fx(c),history:(i,o)=>fixture.history(i,o)};
  const live=await validateProvider(db.appPool,unvalidated);
  expect(live.every(row=>row.mode==='live'&&!row.tradable&&row.orderResult==='INSTRUMENT_UNAVAILABLE')).toBe(true);
  expect(live.every(row=>row.blockers.includes('LIVE_PROVIDER_NOT_ACCEPTED')&&row.blockers.includes('CORPORATE_ACTION_COVERAGE_UNVERIFIED'))).toBe(true);
  expect((await db.appPool.query('SELECT count(*)::int AS count FROM executions')).rows[0]!.count).toBe(6);
});

it('reports six unavailable regions without replacing failed live observations with fixtures', async () => {
  db=await createHarness(); await migrate(db.ownerPool);
  const failed:MarketProvider={name:'offline-live',search:async()=>[],quote:async()=>{throw Error('offline');},fx:async()=>{throw Error('offline');},history:async()=>{throw Error('offline');}};
  const report=await validateProvider(db.appPool,failed);
  expect(report).toHaveLength(6);
  expect(report.every(row=>row.mode==='live'&&row.orderResult==='NOT_ATTEMPTED'&&row.price===null&&row.blockers.includes('INSTRUMENT_UNAVAILABLE'))).toBe(true);
  expect((await db.appPool.query('SELECT count(*)::int AS count FROM executions')).rows[0]!.count).toBe(0);
});

it('records missing quotes, FX and history while continuing to check the live order gate', async () => {
  db=await createHarness(); await migrate(db.ownerPool);
  const fixture=new FixtureProvider();
  const outage:MarketProvider={name:'outage-live',search:q=>fixture.search(q),quote:async()=>{throw Error('offline');},fx:async()=>{throw Error('offline');},history:async()=>{throw Error('offline');}};
  const report=await validateProvider(db.appPool,outage);
  expect(report).toHaveLength(6);
  expect(report.every(row=>row.price===null&&row.historyBars===0&&row.orderResult==='INSTRUMENT_UNAVAILABLE'&&row.blockers.includes('QUOTE_UNAVAILABLE'))).toBe(true);
  expect(report.find(row=>row.currency==='USD')!.blockers).toContain('FX_UNAVAILABLE');
  expect(report.find(row=>row.currency==='INR')!.fxRate).toBe('1.000000000000');
});

it('reports a pause discovered during refresh instead of using the earlier instrument metadata', async () => {
  db=await createHarness(); await migrate(db.ownerPool);
  const fixture=new FixtureProvider();
  const changed:MarketProvider={name:'changed-units-live',search:q=>fixture.search(q),quote:async i=>({...await fixture.quote(i),rawCurrency:'CHANGED'}),fx:c=>fixture.fx(c),history:(i,o)=>fixture.history(i,o)};
  const report=await validateProvider(db.appPool,changed);
  expect(report).toHaveLength(6);
  expect(report.every(row=>row.blockers.includes('INSTRUMENT_PAUSED')&&row.blockers.includes('QUOTE_UNAVAILABLE')&&row.orderResult==='INSTRUMENT_UNAVAILABLE')).toBe(true);
});
