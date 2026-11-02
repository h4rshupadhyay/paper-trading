import { afterEach, expect, it } from 'vitest';
import { migrate } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';
import { FixtureProvider, type MarketProvider, type ProviderQuote } from '../src/modules/market-data/provider.js';
import { discoverInstruments, refreshInstrument, readQuote, readHistory, refreshActive } from '../src/modules/market-data/service.js';

let db: TestHarness | undefined;
afterEach(async () => { await db?.close(); db = undefined; });
async function setup(symbol = 'AAPL') {
  db = await createHarness(); await migrate(db.ownerPool, 2);
  const provider = new FixtureProvider();
  const items = await discoverInstruments(db.appPool, symbol, provider);
  return { pool: db.appPool, provider, instrument: items.find(x => x.symbol === symbol)! };
}
const now = () => new Date().toISOString();
function quote(overrides: Partial<ProviderQuote> = {}): ProviderQuote {
  return { rawPrice: '150', rawCurrency: 'USD', observedAt: now(), session: 'REGULAR', actionKey: 'fixture-v1', ...overrides };
}
function source(result: ProviderQuote | Error, base = new FixtureProvider()): MarketProvider {
  return { name: 'fixture', search: q => base.search(q), history: i => base.history(i), fx: c => base.fx(c), quote: async () => { if (result instanceof Error) throw result; return result; } };
}

// Catch missing schema privileges and binary-floating arithmetic/incorrect GBp normalization.
it('normalizes source pence to exact GBP major units using PostgreSQL', async () => {
  const { pool, instrument } = await setup('VOD.L');
  await refreshInstrument(pool, instrument.id, source(quote({ rawPrice: '7123.456789', rawCurrency: 'GBp' })));
  const result = await readQuote(pool, instrument.id);
  expect(result.quote).toMatchObject({ price: '71.23456789', currency: 'GBP', rawPrice: '7123.456789', rawCurrency: 'GBp', quality: 'fresh' });
});

// Catch mutation of latest quote by old/future/invalid metadata or loss during outage.
it('keeps a newer observation on out of order delivery and provider failures', async () => {
  const { pool, instrument } = await setup();
  await refreshInstrument(pool, instrument.id, source(quote()));
  await refreshInstrument(pool, instrument.id, source(quote({ rawPrice: '99', observedAt: new Date(Date.now() - 5000).toISOString() })));
  await refreshInstrument(pool, instrument.id, source(new Error('network')));
  expect((await readQuote(pool, instrument.id)).quote?.price).toBe('150.00000000');
});

it.each([
  { rawPrice: 'NaN' }, { rawPrice: '0' }, { rawPrice: '-1' }, { rawCurrency: 'EUR' },
  { observedAt: 'invalid' }, { observedAt: new Date(Date.now() + 60000).toISOString() },
  { actionKey: '' }, { session: 'PRE' as ProviderQuote['session'] },
])('rejects unusable source metadata without inserting a quote %#', async invalid => {
  const { pool, instrument } = await setup();
  await refreshInstrument(pool, instrument.id, source(quote(invalid)));
  expect((await readQuote(pool, instrument.id)).quote).toBeNull();
});

it('marks stale and closed observations and never extends freshness with fetch time', async () => {
  const { pool, instrument } = await setup();
  await refreshInstrument(pool, instrument.id, source(quote({ observedAt: new Date(Date.now() - 61000).toISOString(), session: 'CLOSED' })));
  expect((await readQuote(pool, instrument.id)).quote).toMatchObject({ session: 'CLOSED', quality: 'stale' });
});

it('pauses an instrument when corporate action identity changes', async () => {
  const { pool, instrument } = await setup();
  await refreshInstrument(pool, instrument.id, source(quote()));
  await refreshInstrument(pool, instrument.id, source(quote({ actionKey: 'split-2-for-1' })));
  expect((await pool.query('SELECT paused FROM instruments WHERE id=$1', [instrument.id])).rows[0]).toEqual({ paused: true });
});

it('serializes refresh with a dedicated advisory lock and releases it after failure', async () => {
  const { pool, instrument } = await setup();
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = source(quote());
  provider.quote = async () => { entered(); await gate; return quote({ rawPrice: '201' }); };
  const first = refreshInstrument(pool, instrument.id, provider);
  await waiting;
  await refreshInstrument(pool, instrument.id, source(quote({ rawPrice: '300' })));
  expect((await readQuote(pool, instrument.id)).quote).toBeNull();
  release(); await first;
  expect((await readQuote(pool, instrument.id)).quote?.price).toBe('201.00000000');
  await refreshInstrument(pool, instrument.id, source(new Error('timeout')));
  await refreshInstrument(pool, instrument.id, source(quote({ rawPrice: '202' })));
  expect((await readQuote(pool, instrument.id)).quote?.price).toBe('202.00000000');
});

it('supplies deterministic discovery, unadjusted history and explicit FX without trading indices', async () => {
  const { pool, provider, instrument } = await setup();
  const instruments = await discoverInstruments(pool, '', provider);
  expect(instruments.some(i => i.kind === 'INDEX' && i.tradable === false)).toBe(true);
  expect(new Set(instruments.map(i => i.currency))).toEqual(new Set(['INR', 'USD', 'GBP', 'EUR', 'JPY', 'HKD']));
  await refreshInstrument(pool, instrument.id, provider);
  expect((await pool.query("SELECT rate FROM latest_fx_rates WHERE currency='USD'")).rows[0]).toEqual({ rate: '83.000000000000' });
  const history = await readHistory(pool, instrument.id, provider);
  expect(history.items[0]).toMatchObject({ open: '149.00000000', high: '151.00000000', low: '148.00000000', close: '150.00000000' });
  await expect(refreshActive(pool, provider)).resolves.toBeUndefined();
});

it('keeps a newer FX observation and labels old FX without trusting its fetch timestamp', async () => {
  const { pool, provider, instrument } = await setup();
  await refreshInstrument(pool, instrument.id, provider);
  const older = source(quote());
  older.fx = async () => ({ rate: '99', observedAt: new Date(Date.now() - 3600000).toISOString() });
  await refreshInstrument(pool, instrument.id, older);
  expect((await pool.query("SELECT rate FROM latest_fx_rates WHERE currency='USD'")).rows[0]?.rate).toBe('83.000000000000');
  await pool.query("UPDATE latest_fx_rates SET observed_at=clock_timestamp()-interval '25 hours' WHERE currency='USD'");
  const { readFxRates } = await import('../src/modules/market-data/service.js');
  expect((await readFxRates(pool)).items.find(i => i.currency === 'USD')).toMatchObject({ quality: 'stale' });
});

it('does not persist a future FX observation or a nonpositive rate', async () => {
  const { pool, instrument } = await setup();
  const provider = source(quote());
  provider.fx = async () => ({ rate: '100', observedAt: new Date(Date.now() + 60000).toISOString() });
  await refreshInstrument(pool, instrument.id, provider);
  expect((await pool.query("SELECT * FROM latest_fx_rates WHERE currency='USD'")).rows).toEqual([]);
  provider.fx = async () => ({ rate: '0', observedAt: now() });
  await refreshInstrument(pool, instrument.id, provider);
  expect((await pool.query("SELECT * FROM latest_fx_rates WHERE currency='USD'")).rows).toEqual([]);
});

// Missing database clock guard would allow a source clock skew to become usable metadata.
it('rejects timezone ambiguous provider observation times', async () => {
  const { pool, instrument } = await setup();
  await refreshInstrument(pool, instrument.id, source(quote({ observedAt: new Date().toISOString().replace('Z', '') })));
  expect((await readQuote(pool, instrument.id)).quote).toBeNull();
});
it('normalizes provider numeric lexemes with long fractional precision in SQL for quotes and history', async () => {
  const { pool,instrument }=await setup();
  const provider=source(quote({rawPrice:'150.12345678912345'}));
  provider.history=async()=>[{observedAt:now(),open:'149.12345678912345',high:'151.12345678912345',low:'148.12345678912345',close:'150.12345678912345',volume:'100'}];
  await refreshInstrument(pool,instrument.id,provider);
  expect((await readQuote(pool,instrument.id)).quote?.price).toBe('150.12345679');
  expect((await readHistory(pool,instrument.id,provider)).items[0]?.close).toBe('150.12345679');
});
it('pauses on an action change even when the provider quote timestamp is unchanged', async () => {
  const {pool,instrument}=await setup(); const observation=now();
  await refreshInstrument(pool,instrument.id,source(quote({observedAt:observation})));
  await refreshInstrument(pool,instrument.id,source(quote({observedAt:observation,actionKey:'new-action'})));
  expect((await pool.query('SELECT paused FROM instruments WHERE id=$1',[instrument.id])).rows[0]?.paused).toBe(true);
});
it('pauses an existing instrument when its source unit metadata changes', async () => {
  const {pool,instrument}=await setup();
  await refreshInstrument(pool,instrument.id,source(quote()));
  await refreshInstrument(pool,instrument.id,source(quote({rawCurrency:'EUR'})));
  expect((await pool.query('SELECT paused FROM instruments WHERE id=$1',[instrument.id])).rows[0]?.paused).toBe(true);
  expect((await readQuote(pool,instrument.id)).quality).toBe('unavailable');
});
it('does not expose cached fixture FX as live provider data during a live outage', async () => {
  const {pool,provider}=await setup(); const {readFxRates}=await import('../src/modules/market-data/service.js');
  await readFxRates(pool,provider);
  const live: MarketProvider={...source(quote()),name:'yahoo',fx:async()=>{throw new Error('live outage');}};
  const result=await readFxRates(pool,live);
  expect(result.items.map(i=>i.currency)).toEqual(['INR']);
});
it('does not substitute history from a different provider when provider mode changes',async()=>{
  const {pool,instrument}=await setup();
  const other:MarketProvider={...source(quote()),name:'yahoo'};
  expect((await readHistory(pool,instrument.id,other)).quality).toBe('unavailable');
});

async function activeCatalogue(count: number) {
  db=await createHarness(); await migrate(db.ownerPool,2);
  await db.ownerPool.query('CREATE TABLE positions (instrument_id uuid PRIMARY KEY REFERENCES instruments(id)); GRANT SELECT ON positions TO paper_app');
  await db.appPool.query(`INSERT INTO instruments(id,symbol,name,exchange,currency,multiplier,kind,tradable,provider)
    SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'ACTIVE'||lpad(n::text,4,'0'),'Active fixture '||n,'TEST','INR',1,'EQUITY',true,'fixture' FROM generate_series(1,$1::integer) n`,[count]);
  await db.ownerPool.query('INSERT INTO positions SELECT id FROM instruments');
  return db.appPool;
}
it('rotates a bounded active refresh batch past unavailable candidates using durable attempt age',async()=>{
  const pool=await activeCatalogue(13);
  const provider=source(quote({rawCurrency:'INR'}));
  provider.quote=async instrument=>{if(Number(instrument.symbol.slice(6))<=8)throw new Error('unavailable'); return quote({rawCurrency:'INR'});};
  await refreshActive(pool,provider);
  expect((await pool.query('SELECT count(*)::integer AS count FROM latest_quotes')).rows[0]?.count).toBe(0);
  expect((await pool.query("SELECT count(*)::integer AS count FROM instruments WHERE refresh_attempted_at>'-infinity'::timestamptz")).rows[0]?.count).toBe(8);
  await refreshActive(pool,provider);
  expect((await pool.query('SELECT count(*)::integer AS count FROM latest_quotes')).rows[0]?.count).toBe(5);
  expect((await pool.query("SELECT count(*)::integer AS count FROM instruments WHERE refresh_attempted_at>'-infinity'::timestamptz")).rows[0]?.count).toBe(13);
});
it('bounds active provider concurrency to two and skips a competing worker batch',async()=>{
  const pool=await activeCatalogue(13); let calls=0,active=0,max=0; let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const provider=source(quote({rawCurrency:'INR'}));
  provider.quote=async()=>{calls++; active++; max=Math.max(max,active); try {await gate;return quote({rawCurrency:'INR'});} finally {active--;}};
  const first=refreshActive(pool,provider);
  try {
    // Real provider boundary held open while independent database connections compete.
    await new Promise(resolve=>setTimeout(resolve,60));
    expect(active).toBe(2);
    await refreshActive(pool,provider);
    expect(calls).toBe(2);
  } finally {release(); await first;}
  expect(max).toBe(2); expect(calls).toBe(8);
});
it('ends a stalled active batch within one shared network budget without starting FX or later candidates',async()=>{
  const pool=await activeCatalogue(13);
  await db!.ownerPool.query("UPDATE instruments SET currency='USD'");
  let quoteCalls=0,fxCalls=0; let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const provider=source(quote());
  provider.quote=async()=>{quoteCalls++;await gate;return quote();};
  provider.fx=async()=>{fxCalls++;await gate;return {rate:'83',observedAt:now()};};
  const started=Date.now();
  try {
    await refreshActive(pool,provider);
    expect(Date.now()-started).toBeLessThan(9500);
    expect(quoteCalls).toBe(2); expect(fxCalls).toBe(0);
    expect((await pool.query("SELECT count(*)::integer AS count FROM instruments WHERE refresh_attempted_at>'-infinity'::timestamptz")).rows[0]?.count).toBe(2);
  } finally {release();}
  await new Promise(resolve=>setImmediate(resolve));
  expect((await pool.query('SELECT count(*)::integer AS count FROM latest_quotes')).rows[0]?.count).toBe(0);
});
it('permits attempt scheduling updates while refusing runtime currency or provider reassignment',async()=>{
  const {pool,instrument}=await setup();
  await expect(pool.query('UPDATE instruments SET refresh_attempted_at=clock_timestamp() WHERE id=$1',[instrument.id])).resolves.toMatchObject({rowCount:1});
  await expect(pool.query("UPDATE instruments SET currency='EUR' WHERE id=$1",[instrument.id])).rejects.toMatchObject({code:'42501'});
  await expect(pool.query("UPDATE instruments SET provider='yahoo' WHERE id=$1",[instrument.id])).rejects.toMatchObject({code:'42501'});
});
