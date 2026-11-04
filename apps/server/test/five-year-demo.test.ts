import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createHarness,type TestHarness} from './harness.js';
import {migrate} from '../src/platform/migrate.js';
import {fiveYearHistory} from './fixtures/five-year-history.js';
import {demoHistory} from './fixtures/demo-history.js';
import {seedDemo} from '../src/modules/demo/seed.js';
import {prepareFiveYearHistory} from '../src/modules/demo/five-year.js';
import {upgradeFiveYearDemo,seedFiveYearDemo} from '../src/modules/demo/five-year-upgrade.js';
import {reconcileAccount} from '../src/modules/accounts/reconciliation.js';
let h:TestHarness;
const options={password:'five year password 123',nodeEnv:'test' as const,provider:'yfinance' as const};
beforeEach(async()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));h=await createHarness();await migrate(h.ownerPool);});
afterEach(async()=>{await h?.close();vi.useRealTimers();});
it('spreads actual-session trades over five years and avoids unsupported pre-demerger Reliance exposure',()=>{
  const data=prepareFiveYearHistory(fiveYearHistory());
  expect(new Set(data.trades.map(t=>t.sessionDate.slice(0,4))).size).toBeGreaterThanOrEqual(5);
  expect(data.trades.filter(t=>t.symbol==='RELIANCE.NS').every(t=>t.sessionDate>'2023-07-20')).toBe(true);
  expect(data.actions.some(t=>t.kind==='SPLIT')).toBe(true);
  expect(data.samples.length).toBeGreaterThan(1000);
  for(const t of data.trades)expect(Date.parse(t.fxAt)).toBeLessThanOrEqual(Date.parse(t.at));
  const invalid=fiveYearHistory();invalid.series.MSFT.items=[];
  expect(()=>prepareFiveYearHistory(invalid)).toThrow();
});
it('creates five-year actions, cash, positions and chronological history that independently reconcile',async()=>{
  const result=await seedFiveYearDemo(h.appPool,{...options,history:fiveYearHistory()});
  expect(result.created).toBe(true);
  // Hand-derived for constant prices/FX and the deterministic quarterly plan:
  // AAPL15*100*80 + MSFT4*200*80 + REL16*500 =192000 cost.
  // Gross dividends: AAPL(11+13+14+15)*80 + MSFT(5+5+5+5)*80 + REL(9+17+16)*2 =5924.
  expect((await h.appPool.query('SELECT cash_balance::text,cash_sequence::text FROM accounts')).rows[0]).toEqual({cash_balance:'813924.00',cash_sequence:'43'});
  expect((await h.appPool.query("SELECT sum(base_amount)::text total FROM account_actions WHERE kind='DIVIDEND'")).rows[0]!.total).toBe('5924.00');
  expect((await h.appPool.query('SELECT total_value::text FROM portfolio_snapshots ORDER BY sampled_at DESC LIMIT 1')).rows[0]!.total_value).toBe('1005924.00');
  expect(await reconcileAccount(h.appPool,result.userId)).toMatchObject({balanced:true});
  expect((await h.appPool.query('SELECT count(*)::int n FROM account_actions')).rows[0]!.n).toBeGreaterThan(5);
  expect((await h.appPool.query('SELECT count(*)::int n FROM portfolio_snapshots')).rows[0]!.n).toBeGreaterThan(1000);
  expect((await h.appPool.query('SELECT version FROM demo_history_versions')).rows[0]!.version).toBe(3);
});
it('guards and backs up a v2 upgrade, preserving credentials/cancelled orders and making repeated upgrades no-ops',async()=>{
  const prior=demoHistory();await seedDemo(h.appPool,{...options,history:prior});
  await h.appPool.query("UPDATE orders SET status='CANCELLED',completed_at=now() WHERE type='STOP_LIMIT'");
  const before=(await h.appPool.query('SELECT id,password_hash FROM users')).rows;
  let backup=false;
  expect(await upgradeFiveYearDemo(h.ownerPool,{nodeEnv:'test',history:fiveYearHistory(),priorHistory:prior,backup:async()=>{backup=true;}})).toMatchObject({updated:true});
  expect(backup).toBe(true);expect((await h.appPool.query('SELECT id,password_hash FROM users')).rows).toEqual(before);
  expect((await h.appPool.query("SELECT status FROM orders WHERE type='STOP_LIMIT'")).rows[0]!.status).toBe('CANCELLED');
  expect(await reconcileAccount(h.appPool,before[0]!.id)).toMatchObject({balanced:true});
  expect(await upgradeFiveYearDemo(h.ownerPool,{nodeEnv:'test',history:fiveYearHistory(),backup:async()=>{throw Error('no backup on no-op');}})).toMatchObject({updated:false});
});
it('refuses changed v2 accounting and rolls back after a late replacement failure',async()=>{
  const prior=demoHistory();await seedDemo(h.appPool,{...options,history:prior});
  const before=(await h.appPool.query('SELECT cash_balance::text FROM accounts')).rows;
  await h.ownerPool.query("CREATE FUNCTION fail_v3() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late v3 fault'; END $$; CREATE TRIGGER fail_v3 BEFORE INSERT ON demo_history_versions FOR EACH ROW EXECUTE FUNCTION fail_v3()");
  await expect(upgradeFiveYearDemo(h.ownerPool,{nodeEnv:'test',history:fiveYearHistory(),priorHistory:prior,backup:async()=>{}})).rejects.toThrow('late v3 fault');
  expect((await h.appPool.query('SELECT cash_balance::text FROM accounts')).rows).toEqual(before);
  await h.ownerPool.query('DROP TRIGGER fail_v3 ON demo_history_versions');
  await h.ownerPool.query('UPDATE executions SET price=price+1 WHERE id=(SELECT id FROM executions LIMIT 1)');
  await expect(upgradeFiveYearDemo(h.ownerPool,{nodeEnv:'test',history:fiveYearHistory(),priorHistory:prior,backup:async()=>{}})).rejects.toThrow(/changed|recognized/i);
});

it('omits cutoffs that combine post-split shares with an unavailable ex-date close',()=>{
  const history=fiveYearHistory();
  for(const b of history.series.AAPL.items){if(b.sessionDate>='2024-10-29')b.close='50';if(b.sessionDate==='2024-10-29')b.split='2';}
  const data=prepareFiveYearHistory(history);
  expect(data.samples.some(s=>s.at==='2024-10-29T06:00:00.000Z')).toBe(false);
  expect(data.samples.find(s=>s.at==='2024-10-30T06:00:00.000Z')?.prices.AAPL).toBe('50');
});
