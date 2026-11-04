import {beforeEach,afterEach,it,expect} from 'vitest';
import {demoHistory} from './fixtures/demo-history.js';
import {seedDemo as legacySeed} from './fixtures/legacy-demo.js';
import {seedDemo} from '../src/modules/demo/seed.js';
import {upgradeDemo} from '../src/modules/demo/upgrade.js';
import {prepareDemoHistory} from '../src/modules/demo/history.js';
import {reconcileAccount} from '../src/modules/accounts/reconciliation.js';
import {migrate} from '../src/platform/migrate.js';
import {createHarness,type TestHarness} from './harness.js';
let h:TestHarness;
const options={password:'demo history password 123',nodeEnv:'test' as const,provider:'yfinance' as const};
beforeEach(async()=>{h=await createHarness();await migrate(h.ownerPool);});
afterEach(async()=>{await h?.close();});

it('selects actual completed sessions and as-of FX, refusing missing or future observations',()=>{
  const bundle=demoHistory();const prepared=prepareDemoHistory(bundle);
  expect(prepared.trades).toHaveLength(5);
  for(const t of prepared.trades){expect(Date.parse(t.fxAt)).toBeLessThanOrEqual(Date.parse(t.at));expect([0,6]).not.toContain(new Date(t.at).getUTCDay());}
  const wrong=structuredClone(bundle);wrong.series['USDINR=X']!.items=[];
  expect(()=>prepareDemoHistory(wrong)).toThrow();
  const future=structuredClone(bundle);future.series.AAPL!.items[0]!.availableAt='2999-01-01T00:00:00Z';
  expect(()=>prepareDemoHistory(future)).toThrow();
  expect(()=>prepareDemoHistory({...bundle,corporateActions:'split'})).toThrow();
  expect(()=>prepareDemoHistory({...bundle,fetchedAt:'2020-01-01T00:00:00Z'})).toThrow();
});

it('creates affordable nearby orders with buy stop-limit limit above stop and reconciles history',async()=>{
  const result=await seedDemo(h.appPool,{...options,history:demoHistory()});
  const orders=(await h.appPool.query("SELECT i.symbol,o.limit_price::text,o.stop_price::text FROM orders o JOIN instruments i ON i.id=o.instrument_id WHERE status='OPEN' ORDER BY symbol")).rows;
  expect(orders).toEqual([
    {symbol:'AAPL',limit_price:'196.00000000',stop_price:null},
    {symbol:'MSFT',limit_price:'410.00000000',stop_price:'408.00000000'},
    {symbol:'RELIANCE.NS',limit_price:null,stop_price:'1425.00000000'},
  ]);
  expect(await reconcileAccount(h.appPool,result.userId)).toMatchObject({balanced:true});
  const snap=(await h.appPool.query('SELECT cash_balance::text,holdings_value::text,total_value::text,unrealized_pl::text,quality FROM portfolio_snapshots ORDER BY sampled_at DESC LIMIT 1')).rows[0];
  expect(snap).toEqual({cash_balance:'707500.00',holdings_value:'292500.00',total_value:'1000000.00',unrealized_pl:'0.00000000',quality:'stale'});
  expect((await h.appPool.query("SELECT body FROM notes WHERE title='Demo: history provenance'")).rows[0]!.body).toContain('daily closing prices');
});

it('upgrades only original history, preserving credentials, edits and a cancelled MSFT order; repeat is a no-op',async()=>{
  const original=await legacySeed(h.appPool,options);
  await h.appPool.query("UPDATE orders SET status='CANCELLED',completed_at=now(),updated_at=now() WHERE type='STOP_LIMIT'");
  await h.appPool.query("UPDATE notes SET body='My own journal' WHERE title='Demo: trading journal'");
  const before=(await h.appPool.query('SELECT password_hash FROM users')).rows[0];
  let backup:unknown;
  const result=await upgradeDemo(h.ownerPool,{history:demoHistory(),nodeEnv:'test',backup:async value=>{backup=value;}});
  expect(result.updated).toBe(true);expect(backup).toBeDefined();
  expect((await h.appPool.query('SELECT password_hash FROM users')).rows[0]).toEqual(before);
  expect((await h.appPool.query("SELECT body FROM notes WHERE title='Demo: trading journal'")).rows[0]!.body).toBe('My own journal');
  expect((await h.appPool.query("SELECT status,stop_price::text FROM orders WHERE type='STOP_LIMIT'")).rows[0]).toEqual({status:'CANCELLED',stop_price:'100000.00000000'});
  expect(await reconcileAccount(h.appPool,original.userId)).toMatchObject({balanced:true});
  const capture=async()=>(await h.appPool.query('SELECT row_to_json(e) value FROM executions e ORDER BY id')).rows;
  const upgraded=await capture();
  expect(await upgradeDemo(h.ownerPool,{history:demoHistory(),nodeEnv:'test',backup:async()=>{throw Error('must not back up no-op');}})).toMatchObject({updated:false});
  expect(await capture()).toEqual(upgraded);
});

it('refuses changed accounting and fails atomically when backup cannot be saved',async()=>{
  await legacySeed(h.appPool,options);
  const before=(await h.appPool.query('SELECT cash_balance::text FROM accounts')).rows;
  await expect(upgradeDemo(h.ownerPool,{history:demoHistory(),nodeEnv:'test',backup:async()=>{throw Error('disk full');}})).rejects.toThrow('disk full');
  expect((await h.appPool.query('SELECT cash_balance::text FROM accounts')).rows).toEqual(before);
  await h.ownerPool.query('UPDATE executions SET price=price+1 WHERE id=(SELECT id FROM executions LIMIT 1)');
  await expect(upgradeDemo(h.ownerPool,{history:demoHistory(),nodeEnv:'test',backup:async()=>{}})).rejects.toThrow(/original|changed/i);
  expect((await h.appPool.query('SELECT cash_balance::text FROM accounts')).rows).toEqual(before);
});

it('uses newly published FX only for later valuations, preserving earlier fill settlements',async()=>{
  const history=demoHistory();history.series['USDINR=X']!.items.at(-1)!.close='100';
  await seedDemo(h.appPool,{...options,history});
  expect((await h.appPool.query("SELECT bool_and(fx_rate=90) valid FROM executions WHERE currency='USD'")).rows[0]!.valid).toBe(true);
  expect((await h.appPool.query('SELECT holdings_value::text FROM portfolio_snapshots ORDER BY sampled_at DESC LIMIT 1')).rows[0]!.holdings_value).toBe('322500.00');
});

it('rolls back all financial replacements after a late failure and preserves other accounts',async()=>{
  await legacySeed(h.appPool,options);
  await h.ownerPool.query("INSERT INTO users(id,username,email,password_hash) VALUES('ab000000-0000-4000-8000-000000000001','untouched','untouched@example.com','hash'); INSERT INTO accounts(user_id,cash_balance,cash_sequence) VALUES('ab000000-0000-4000-8000-000000000001',1000000,1)");
  const capture=async()=>{
    const out:unknown[]=[];
    for(const table of ['accounts','executions','cash_movements','positions','orders','portfolio_snapshots','notes','price_alerts','notifications','instruments','latest_quotes','latest_fx_rates'])out.push((await h.appPool.query(`SELECT row_to_json(t) value FROM ${table} t ORDER BY row_to_json(t)::text`)).rows);
    return out;
  };
  const before=await capture();
  await h.ownerPool.query("CREATE FUNCTION fail_upgrade_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late upgrade fault'; END $$; CREATE TRIGGER fail_upgrade_note BEFORE INSERT ON notes FOR EACH ROW EXECUTE FUNCTION fail_upgrade_note()");
  await expect(upgradeDemo(h.ownerPool,{history:demoHistory(),nodeEnv:'test',backup:async()=>{}})).rejects.toThrow('late upgrade fault');
  expect(await capture()).toEqual(before);
  await h.ownerPool.query('DROP TRIGGER fail_upgrade_note ON notes');
  await upgradeDemo(h.ownerPool,{history:demoHistory(),nodeEnv:'test',backup:async()=>{}});
  expect((await h.appPool.query("SELECT cash_balance::text,cash_sequence::text FROM accounts WHERE user_id='ab000000-0000-4000-8000-000000000001'")).rows).toEqual([{cash_balance:'1000000.00',cash_sequence:'1'}]);
});

it('refuses any additional execution and production maintenance',async()=>{
  await legacySeed(h.appPool,options);
  await expect(upgradeDemo(h.ownerPool,{history:demoHistory(),nodeEnv:'production',backup:async()=>{}})).rejects.toThrow(/production/);
  await h.ownerPool.query(`WITH new_order AS (
    INSERT INTO orders(account_id,instrument_id,idempotency_key,intent_fingerprint,side,type,quantity,status)
    SELECT account_id,instrument_id,'additional-user-trade',intent_fingerprint,side,type,quantity,'FILLED' FROM orders WHERE status='FILLED' LIMIT 1 RETURNING *
  ) INSERT INTO executions(order_id,account_id,instrument_id,side,quantity,price,currency,native_amount,fx_rate,settlement,allocated_native_cost,allocated_base_cost,realized_pl,quote_observed_at,fx_observed_at)
    SELECT n.id,n.account_id,n.instrument_id,n.side,n.quantity,e.price,e.currency,e.native_amount,e.fx_rate,e.settlement,e.allocated_native_cost,e.allocated_base_cost,e.realized_pl,e.quote_observed_at,e.fx_observed_at FROM new_order n JOIN executions e ON e.instrument_id=n.instrument_id AND e.side=n.side LIMIT 1`);
  await expect(upgradeDemo(h.ownerPool,{history:demoHistory(),nodeEnv:'test',backup:async()=>{throw Error('guard should precede backup');}})).rejects.toThrow(/original seed/);
});

it('refuses malformed completion timestamps and sparse out-of-order FX observations',()=>{
  const wrong=demoHistory();wrong.series['USDINR=X']!.items[10]!.closedAt=wrong.series['USDINR=X']!.items[2]!.closedAt;
  expect(()=>prepareDemoHistory(wrong)).toThrow();
  const invalid=demoHistory();invalid.series.AAPL!.items[0]!.availableAt=invalid.series.AAPL!.items[0]!.sessionDate+'T00:00:00Z';
  expect(()=>prepareDemoHistory(invalid)).toThrow();
});


it('samples only after the session daily bars have actually become available',()=>{
  const history=demoHistory();const data=prepareDemoHistory(history);
  const sample=data.samples[0]!;
  const first=data.trades[0]!;
  const source=history.series.AAPL!.items.find(b=>b.sessionDate===first.sessionDate)!;
  expect(Date.parse(sample.at)).toBeGreaterThanOrEqual(Date.parse(source.availableAt));
});

it('does not race an active worker snapshot batch during upgrade',async()=>{
  await legacySeed(h.appPool,options);
  const worker=await h.appPool.connect();
  try{
    await worker.query('SELECT pg_advisory_lock(1480963205)');
    await expect(upgradeDemo(h.ownerPool,{history:demoHistory(),nodeEnv:'test',backup:async()=>{}})).rejects.toThrow(/worker/i);
    expect((await h.appPool.query('SELECT cash_balance::text FROM accounts')).rows[0]!.cash_balance).toBe('754255.00');
  }finally{await worker.query('SELECT pg_advisory_unlock(1480963205)');worker.release();}
});

it('preserves user-created alerts even if their thresholds duplicate legacy defaults',async()=>{
  const user=await legacySeed(h.appPool,options);
  await h.ownerPool.query("INSERT INTO price_alerts(user_id,instrument_id,condition,target_price,created_at) SELECT $1,id,'ABOVE',100000,now()+interval '1 second' FROM instruments WHERE symbol='MSFT'",[user.userId]);
  const newAlert=(await h.appPool.query("SELECT id FROM price_alerts ORDER BY created_at DESC LIMIT 1")).rows[0]!.id;
  await upgradeDemo(h.ownerPool,{history:demoHistory(),nodeEnv:'test',backup:async()=>{}});
  expect((await h.appPool.query('SELECT target_price::text FROM price_alerts WHERE id=$1',[newAlert])).rows[0]!.target_price).toBe('100000.00000000');
});

it('rounds each historical position before adding holdings, matching current valuation',async()=>{
  const history=demoHistory();for(const b of history.series['USDINR=X']!.items)b.close='90.000003';
  const result=await seedDemo(h.appPool,{...options,history});
  const sample=(await h.appPool.query('SELECT holdings_value::text,cash_balance::text FROM portfolio_snapshots ORDER BY sampled_at DESC LIMIT 1')).rows[0];
  expect(sample).toEqual({holdings_value:'292500.00',cash_balance:'707499.99'});
  expect(await reconcileAccount(h.appPool,result.userId)).toMatchObject({balanced:true});
});

it('refuses an altered original opening-credit timestamp before replacement',async()=>{
  await legacySeed(h.appPool,options);
  await h.ownerPool.query("UPDATE cash_movements SET created_at=created_at+interval '1 second' WHERE account_sequence=1");
  await expect(upgradeDemo(h.ownerPool,{history:demoHistory(),nodeEnv:'test',backup:async()=>{}})).rejects.toThrow(/original seed/);
});
