import { afterEach, beforeEach, expect, it } from 'vitest';
import { demoHistory } from './fixtures/demo-history.js';
import { seedDemo } from '../src/modules/demo/seed.js';
import { reconcileAccount } from '../src/modules/accounts/reconciliation.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { login } from '../src/modules/identity/sessions.js';
import { migrate } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';

let h: TestHarness;
const password = 'seeded demo password 123';
const options = { password, nodeEnv: 'test' as const, provider: 'yfinance' as const, history: demoHistory() };
beforeEach(async () => { h = await createHarness(); await migrate(h.ownerPool); });
afterEach(async () => { await h?.close(); });

it('seeds a normally authenticated demo with exact reconciled history and owned features', async () => {
  const result = await seedDemo(h.appPool, options);
  expect(result).toMatchObject({ created: true, username: 'demo' });
  expect((await login(h.appPool, { username: 'demo', password }, 'demo tests secret with at least 32 bytes')).user.id).toBe(result.userId);
  expect((await h.appPool.query('SELECT cash_balance::text,cash_sequence::text FROM accounts WHERE user_id=$1', [result.userId])).rows).toEqual([{ cash_balance: '707500.00', cash_sequence: '6' }]);
  expect((await h.appPool.query('SELECT i.symbol,p.quantity::text,p.native_cost::text,p.base_cost::text FROM positions p JOIN instruments i ON i.id=p.instrument_id JOIN accounts a ON a.id=p.account_id WHERE a.user_id=$1 ORDER BY i.symbol', [result.userId])).rows).toEqual([
    { symbol: 'AAPL', quantity: '7.0000', native_cost: '1400.00000000', base_cost: '126000.00000000' },
    { symbol: 'MSFT', quantity: '4.0000', native_cost: '1600.00000000', base_cost: '144000.00000000' },
    { symbol: 'RELIANCE.NS', quantity: '15.0000', native_cost: '22500.00000000', base_cost: '22500.00000000' },
  ]);
  expect((await h.appPool.query('SELECT sum(realized_pl)::text AS pl FROM executions')).rows[0]!.pl).toBe('0.00000000');
  expect(await reconcileAccount(h.appPool, result.userId)).toMatchObject({ balanced: true, positionMismatchCount: 0, executionMismatchCount: 0, ledgerMismatchCount: 0 });
  for (const [table, count] of [['executions',5],['cash_movements',6],['watchlist_entries',3],['notes',3],['price_alerts',3],['notifications',1]] as const) {
    expect((await h.appPool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n).toBe(count);
  }
  expect((await h.appPool.query('SELECT status,count(*)::int AS n FROM orders GROUP BY status ORDER BY status')).rows).toEqual([
    { status:'CANCELLED',n:1 },{ status:'EXPIRED',n:1 },{ status:'FILLED',n:5 },{ status:'OPEN',n:3 },{ status:'REJECTED',n:1 },
  ]);
  expect((await h.appPool.query("SELECT bool_and(updated_at>=completed_at AND (status<>'EXPIRED' OR completed_at>=expires_at)) AS valid FROM orders WHERE completed_at IS NOT NULL")).rows[0]!.valid).toBe(true);
  expect((await h.appPool.query("SELECT bool_and(quality='stale') AS valid FROM portfolio_snapshots")).rows[0]!.valid).toBe(true);
  expect((await h.appPool.query('SELECT count(*)::int AS n FROM latest_quotes')).rows[0]!.n).toBe(0);
  expect((await h.appPool.query('SELECT count(*)::int AS n FROM latest_fx_rates')).rows[0]!.n).toBe(0);
});

it('serializes concurrent seeds and preserves edited demo data and password on repeat', async () => {
  const results = await Promise.all([seedDemo(h.appPool, options), seedDemo(h.appPool, options)]);
  expect(results.map(r => r.created).sort()).toEqual([false,true]);
  await h.appPool.query("UPDATE notes SET title='User-edited demo note' WHERE id=(SELECT id FROM notes LIMIT 1)");
  const before = (await h.appPool.query('SELECT row_to_json(a) AS value FROM accounts a')).rows;
  expect(await seedDemo(h.appPool, { ...options, password:'another valid password' })).toMatchObject({created:false});
  expect((await h.appPool.query('SELECT row_to_json(a) AS value FROM accounts a')).rows).toEqual(before);
  expect((await h.appPool.query("SELECT count(*)::int AS n FROM notes WHERE title='User-edited demo note'")).rows[0]!.n).toBe(1);
  await expect(login(h.appPool,{username:'demo',password},'demo tests secret with at least 32 bytes')).resolves.toBeDefined();
  await expect(login(h.appPool,{username:'demo',password:'another valid password'},'demo tests secret with at least 32 bytes')).rejects.toMatchObject({code:'INVALID_CREDENTIALS'});
});

it.each(['username','email'] as const)('refuses an existing non-demo %s without adopting or modifying it', async field => {
  await registerUser(h.appPool, { username:field==='username'?'demo':'someone',email:field==='email'?'demo@example.invalid':'someone@example.com',password }, async () => 'unchanged-hash');
  const before = (await h.ownerPool.query('SELECT row_to_json(u) AS value FROM users u')).rows;
  await expect(seedDemo(h.appPool, options)).rejects.toThrow(/already in use/);
  expect((await h.ownerPool.query('SELECT row_to_json(u) AS value FROM users u')).rows).toEqual(before);
  expect((await h.appPool.query('SELECT count(*)::int AS n FROM executions')).rows[0]!.n).toBe(0);
});

it('rolls the entire seed back on a late insert fault and permits a subsequent clean run', async () => {
  await h.ownerPool.query("CREATE FUNCTION fail_demo_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected fault'; END $$; CREATE TRIGGER fail_demo_note BEFORE INSERT ON notes FOR EACH ROW EXECUTE FUNCTION fail_demo_note()");
  await expect(seedDemo(h.appPool, options)).rejects.toThrow('injected fault');
  for (const table of ['users','accounts','orders','executions','positions','instruments','cash_movements']) expect((await h.appPool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n).toBe(0);
  await h.ownerPool.query('DROP TRIGGER fail_demo_note ON notes');
  expect(await seedDemo(h.appPool, options)).toMatchObject({created:true});
});

it('preserves other users and every existing shared market row', async () => {
  const other = await registerUser(h.appPool, {username:'other',email:'other@example.com',password}, async ()=>'unchanged-hash');
  await h.ownerPool.query("INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,paused,provider) VALUES('AAPL','Existing metadata','NMS','USD',1,'EQUITY',false,true,'yfinance')");
  await h.ownerPool.query("INSERT INTO latest_quotes(instrument_id,price,observed_at,session,raw_currency,raw_price,action_key,provider) SELECT id,199,now(),'UNKNOWN','USD',199,'unchanged','yfinance' FROM instruments");
  await h.ownerPool.query("INSERT INTO latest_fx_rates(currency,rate,observed_at,provider) VALUES('USD',84,now(),'yfinance')");
  const capture = async () => ({user:(await h.appPool.query('SELECT row_to_json(u) AS value FROM users u WHERE id=$1',[other.user.id])).rows,account:(await h.appPool.query('SELECT row_to_json(a) AS value FROM accounts a WHERE user_id=$1',[other.user.id])).rows,market:(await h.appPool.query("SELECT row_to_json(i) AS value FROM instruments i WHERE symbol='AAPL'")).rows,quotes:(await h.appPool.query('SELECT row_to_json(q) AS value FROM latest_quotes q')).rows,fx:(await h.appPool.query('SELECT row_to_json(f) AS value FROM latest_fx_rates f')).rows});
  const before=await capture();await seedDemo(h.appPool, options);expect(await capture()).toEqual(before);
  expect(await reconcileAccount(h.appPool,other.user.id)).toMatchObject({balanced:true});
});

it('refuses production and invalid passwords before any writes', async () => {
  await expect(seedDemo(h.appPool,{...options,nodeEnv:'production'})).rejects.toThrow(/production/);
  await expect(seedDemo(h.appPool,{...options,password:'short'})).rejects.toThrow();
  expect((await h.appPool.query('SELECT count(*)::int AS n FROM users')).rows[0]!.n).toBe(0);
});
