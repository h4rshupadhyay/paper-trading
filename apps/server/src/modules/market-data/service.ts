import type { Pool, PoolClient } from 'pg';
import { AppError } from '../../platform/errors.js';
import { FixtureProvider, YahooProvider, type Currency, type Instrument, type MarketProvider, type ProviderBar, type ProviderQuote, type HistoryOptions } from './provider.js';
import { YfinanceProvider, YfinanceMetadataChanged } from './yfinance-provider.js';

let selected: MarketProvider | undefined;
export function getProvider(): MarketProvider {
  const mode = process.env.MARKET_PROVIDER ?? 'yfinance';
  if (mode === 'fixture' && process.env.NODE_ENV === 'production') throw new Error('Fixture market provider is forbidden in production');
  if (!['fixture','yahoo','yfinance'].includes(mode)) throw new Error('Unsupported market provider');
  if (!selected || selected.name !== mode) selected = mode === 'fixture' ? new FixtureProvider() : mode==='yfinance' ? new YfinanceProvider() : new YahooProvider();
  return selected;
}
const columns = `id,symbol,name,exchange,currency,multiplier,kind,tradable,paused,provider,unavailable_reason AS "unavailableReason"`;
const decimal = /^(?:0|[1-9]\d{0,19})(?:\.\d{1,24})?$/;
const streamReceipts = new WeakMap<Pool, Map<string,number>>();
const unitChecks = new WeakMap<Pool, Map<string,number>>();
export function streamUnitsDue(pool:Pool,id:string):boolean{return Date.now()-(unitChecks.get(pool)?.get(id)??0)>=60000;}
function markUnitCheck(pool:Pool,id:string):void{
  let checks=unitChecks.get(pool);if(!checks){checks=new Map();unitChecks.set(pool,checks);}
  const now=Date.now();for(const [key,time]of checks)if(now-time>90000)checks.delete(key);
  if(checks.size>=256&&!checks.has(id))checks.delete(checks.keys().next().value!);
  checks.set(id,now);
}
/** Receipt of an accepted stream notification, never an HTTP cache hit. */
export function markStreamReceipt(pool:Pool,id:string):void {
  let receipts=streamReceipts.get(pool);
  if(!receipts){receipts=new Map();streamReceipts.set(pool,receipts);}
  const now=Date.now();
  for(const [key,time] of receipts)if(now-time>15000)receipts.delete(key);
  if(receipts.size>=256&&!receipts.has(id))receipts.delete(receipts.keys().next().value!);
  receipts.set(id,now);
}
function positive(value: string): boolean { return typeof value === 'string' && decimal.test(value) && /[1-9]/.test(value); }
function timestamp(value: string): boolean { const time = Date.parse(value); return typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(time) && time <= Date.now() + 5000 && time > 0; }
function bounded<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Provider timeout')), ms); })]).finally(() => clearTimeout(timer));
}
export async function readInstrument(pool: Pool, id: string): Promise<Instrument> {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid instrument identifier');
  const item = (await pool.query<Instrument>(`SELECT ${columns} FROM public.instruments WHERE id=$1`, [id])).rows[0];
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Instrument not found');
  return item;
}
export async function discoverInstruments(pool: Pool, query: string, provider = getProvider()): Promise<Instrument[]> {
  let discovered: Awaited<ReturnType<MarketProvider['search']>> = [];
  try { discovered = await bounded(provider.search(query), 20000); } catch { /* Known catalogue remains readable during an outage. */ }
  for (const item of discovered.slice(0, 30)) {
    if (!item.symbol || item.symbol.length > 64 || !item.name || item.name.length > 256 || !item.exchange || item.exchange.length > 64
      || !['INR','USD','GBP','EUR','JPY','HKD'].includes(item.currency) || !['1','0.01'].includes(item.multiplier) || !['EQUITY','INDEX'].includes(item.kind)) continue;
    await pool.query(`INSERT INTO public.instruments(symbol,name,exchange,currency,multiplier,kind,tradable,provider,unavailable_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(provider,symbol) DO UPDATE SET
      name=EXCLUDED.name,exchange=EXCLUDED.exchange,
      paused=instruments.paused OR instruments.currency<>EXCLUDED.currency OR instruments.multiplier<>EXCLUDED.multiplier,
      tradable=EXCLUDED.tradable,unavailable_reason=EXCLUDED.unavailable_reason`,
    [item.symbol,item.name,item.exchange,item.currency,item.multiplier,item.kind,item.kind === 'EQUITY' && item.tradable && ['fixture','yfinance'].includes(provider.name),provider.name,item.unavailableReason]);
  }
  return (await pool.query<Instrument>(`SELECT ${columns} FROM public.instruments WHERE provider=$1 AND (strpos(lower(symbol),lower($2))>0 OR strpos(lower(name),lower($2))>0) ORDER BY symbol LIMIT 30`, [provider.name, query])).rows;
}
function validQuote(quote: ProviderQuote, instrument: Instrument): boolean {
  const raw = instrument.multiplier === '0.01000000' ? 'GBp' : instrument.currency;
  return positive(quote.rawPrice) && quote.rawCurrency === raw && timestamp(quote.observedAt)
    && ['REGULAR','CLOSED','UNKNOWN'].includes(quote.session) && typeof quote.actionKey === 'string' && quote.actionKey.length > 0 && quote.actionKey.length <= 256;
}
async function persistQuote(client: PoolClient, instrument: Instrument, quote: ProviderQuote, provider: Pick<MarketProvider,'name'>, strict=false): Promise<boolean> {
  // The provider lock covers the network request; a short SQL transaction keeps pause+quote atomic.
  await client.query('BEGIN');
  try {
    const previous = (await client.query<{ action_key: string; eligible_action: boolean }>('SELECT action_key, observed_at <= $2::timestamptz AS eligible_action FROM public.latest_quotes WHERE instrument_id=$1', [instrument.id,quote.observedAt])).rows[0];
    const saved=await client.query(`INSERT INTO public.latest_quotes(instrument_id,price,raw_currency,raw_price,observed_at,fetched_at,session,action_key,provider)
      SELECT $1,($2::numeric * $3::numeric)::numeric(20,8),$4,$2::numeric,$5,clock_timestamp(),$6,$7,$8
      WHERE $2::numeric * $3::numeric BETWEEN 0.00000001 AND 999999999999.99999999
      ON CONFLICT(instrument_id) DO UPDATE SET price=EXCLUDED.price,raw_currency=EXCLUDED.raw_currency,raw_price=EXCLUDED.raw_price,
      observed_at=GREATEST(latest_quotes.observed_at,EXCLUDED.observed_at),fetched_at=EXCLUDED.fetched_at,session=EXCLUDED.session,action_key=EXCLUDED.action_key,provider=EXCLUDED.provider
      WHERE EXCLUDED.observed_at > latest_quotes.observed_at OR
        (NOT $9::boolean AND EXCLUDED.provider='yfinance'
         AND (EXCLUDED.observed_at=latest_quotes.observed_at OR EXCLUDED.observed_at=date_trunc('second',latest_quotes.observed_at))
         AND EXCLUDED.raw_price=latest_quotes.raw_price AND EXCLUDED.raw_currency=latest_quotes.raw_currency
         AND EXCLUDED.action_key=latest_quotes.action_key AND EXCLUDED.provider=latest_quotes.provider) RETURNING instrument_id`,
    [instrument.id,quote.rawPrice,instrument.multiplier,quote.rawCurrency,quote.observedAt,quote.session,quote.actionKey,provider.name,strict]);
    if ((!strict || saved.rowCount) && previous?.eligible_action && previous.action_key !== quote.actionKey) await client.query('UPDATE public.instruments SET paused=true WHERE id=$1', [instrument.id]);
    if(saved.rowCount)await client.query("SELECT pg_notify('paper_market_quotes',$1)",[JSON.stringify({instrumentId:instrument.id,transport:strict?'stream':'http'})]);
    await client.query('COMMIT');
    return !!saved.rowCount;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
/** A pushed observation never renews an identical source timestamp. */
export async function ingestStreamQuote(pool:Pool,id:string,quote:ProviderQuote):Promise<boolean>{
  const instrument=await readInstrument(pool,id);
  if(instrument.provider!=='yfinance'||quote.session!=='UNKNOWN'||quote.actionKey!=='yfinance-raw'
    ||!positive(quote.rawPrice)||!timestamp(quote.observedAt))return false;
  const client=await pool.connect();let locked=false,discard=false;
  try{
    locked=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(1480963203,hashtext($1)) AS locked',[id])).rows[0]!.locked;
    if(!locked)return false;
    const older=(await client.query('SELECT 1 FROM latest_quotes WHERE instrument_id=$1 AND observed_at >= $2::timestamptz',[id,quote.observedAt])).rowCount;
    if(older)return false;
    if(!validQuote(quote,instrument)){
      if(typeof quote.rawCurrency==='string'&&quote.rawCurrency!==(instrument.multiplier==='0.01000000'?'GBp':instrument.currency)){
        await client.query('UPDATE instruments SET paused=true WHERE id=$1',[id]);
        await client.query("SELECT pg_notify('paper_market_quotes',$1)",[JSON.stringify({instrumentId:id,transport:'http'})]);
      }
      return false;
    }
    const saved=await persistQuote(client,instrument,quote,{name:'yfinance'},true);
    if(saved)markStreamReceipt(pool,id);
    return saved;
  }finally{
    if(locked)try{await client.query('SELECT pg_advisory_unlock(1480963203,hashtext($1))',[id]);}catch{discard=true;}
    client.release(discard);
  }
}
async function persistFx(client: PoolClient, currency: Currency, provider: MarketProvider, deadline = Date.now()+8000): Promise<void> {
  if (Date.now() >= deadline) return;
  let fx;
  try { fx = currency === 'INR' ? { rate: '1', observedAt: new Date().toISOString() } : await bounded(provider.fx(currency),Math.max(1,deadline-Date.now())); } catch { return; }
  if (!positive(fx.rate) || !timestamp(fx.observedAt)) return;
  await client.query(`INSERT INTO public.latest_fx_rates(currency,rate,observed_at,fetched_at,provider)
    SELECT $1,$2::numeric,$3,clock_timestamp(),$4 WHERE $2::numeric BETWEEN 0.000000000001 AND 999999999999.999999999999
    ON CONFLICT(currency) DO UPDATE SET rate=EXCLUDED.rate,observed_at=EXCLUDED.observed_at,fetched_at=EXCLUDED.fetched_at,provider=EXCLUDED.provider
    WHERE EXCLUDED.provider<>latest_fx_rates.provider OR EXCLUDED.observed_at > latest_fx_rates.observed_at OR
      (EXCLUDED.provider='yfinance' AND EXCLUDED.observed_at=latest_fx_rates.observed_at AND EXCLUDED.rate=latest_fx_rates.rate)`, [currency,fx.rate,fx.observedAt,provider.name]);
}
export async function refreshInstrument(pool: Pool, id: string, provider = getProvider()): Promise<void> {
  await refreshWithinDeadline(pool,id,provider,Date.now()+8000);
}
async function refreshWithinDeadline(pool: Pool, id: string, provider: MarketProvider, deadline: number): Promise<void> {
  if (Date.now() >= deadline) return;
  const instrument = await readInstrument(pool, id);
  if (instrument.provider !== provider.name) return;
  const client = await pool.connect(); let locked = false; let discard = false;
  try {
    locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(1480963203,hashtext($1)) AS locked', [id])).rows[0]!.locked;
    if (!locked || Date.now() >= deadline) return;
    // Attempts rotate even on outage; this timestamp never changes observation freshness.
    await client.query('UPDATE public.instruments SET refresh_attempted_at=clock_timestamp() WHERE id=$1',[id]);
    let quote: ProviderQuote | undefined;
    try { if(provider.name!=='yfinance'||Date.now()-(streamReceipts.get(pool)?.get(id)??0)>=10000
      ||streamUnitsDue(pool,id))
      quote = await bounded(provider.quote(instrument),Math.max(1,deadline-Date.now())); } catch(error) {
      if(error instanceof YfinanceMetadataChanged)await client.query('UPDATE public.instruments SET paused=true WHERE id=$1',[instrument.id]);
      // An outage preserves observations without renewing their receipt time.
    }
    if (quote && validQuote(quote, instrument)) {await persistQuote(client, instrument, quote, provider);if(provider.name==='yfinance')markUnitCheck(pool,id);}
    else if (quote && typeof quote.rawCurrency === 'string' && quote.rawCurrency !== (instrument.multiplier === '0.01000000' ? 'GBp' : instrument.currency)) await client.query('UPDATE public.instruments SET paused=true WHERE id=$1',[instrument.id]);
    await persistFx(client, instrument.currency, provider,deadline);
    if (instrument.currency !== 'INR') await persistFx(client, 'INR', provider,deadline);
  } finally {
    if (locked) { try { await client.query('SELECT pg_advisory_unlock(1480963203,hashtext($1))', [id]); } catch { discard = true; } }
    client.release(discard);
  }
}
export async function refreshActive(pool: Pool, provider = getProvider()): Promise<void> {
  const batchClient = await pool.connect(); let locked = false; let discard = false;
  try {
    locked = (await batchClient.query<{locked: boolean}>('SELECT pg_try_advisory_lock(1480963206) AS locked')).rows[0]!.locked;
    if (!locked) return;
    const deadline = Date.now()+8000;
    const clauses: string[] = [];
    for (const name of ['positions','orders','watchlist_entries','price_alerts']) {
      const exists = (await batchClient.query<{ name: string | null }>('SELECT to_regclass($1)::text AS name', [`public.${name}`])).rows[0]!.name;
      if (exists) clauses.push(`SELECT instrument_id FROM public.${name}${name === 'orders' ? " WHERE status IN ('OPEN','TRIGGERED')" : name === 'price_alerts' ? ' WHERE active' : ''}`);
    }
    if (!clauses.length) return;
    const ids = (await batchClient.query<{instrument_id: string}>(`SELECT i.id AS instrument_id FROM public.instruments i
      WHERE i.provider=$1 AND i.id IN (${clauses.join(' UNION ')}) ORDER BY i.refresh_attempted_at,i.id LIMIT 8`,[provider.name])).rows;
    let next = 0;
    const run = async () => {
      while (Date.now() < deadline) {
        const item = ids[next++];
        if (!item) return;
        await refreshWithinDeadline(pool,item.instrument_id,provider,deadline);
      }
    };
    // Await both runners even if one database operation fails, before releasing batch ownership.
    const results = await Promise.allSettled([run(),run()]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  } finally {
    if (locked) { try { await batchClient.query('SELECT pg_advisory_unlock(1480963206)'); } catch { discard = true; } }
    batchClient.release(discard);
  }
}
export type QuoteDto = {
  instrumentId: string; price: string; currency: Currency; observedAt: string; fetchedAt: string;
  session: string; quality: 'fresh'|'stale'|'unavailable'; provider: string; rawCurrency: string; rawPrice: string; actionKey: string;
};
export async function readQuote(pool: Pool, id: string): Promise<{ quote: QuoteDto | null; quality: 'fresh'|'stale'|'unavailable'; unavailableReason: string | null }> {
  const instrument = await readInstrument(pool, id);
  const row = (await pool.query<QuoteDto>(`SELECT instrument_id AS "instrumentId",price,$2::text AS currency,
    to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt",
    to_char(fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "fetchedAt",session,provider,
    raw_currency AS "rawCurrency",raw_price::text AS "rawPrice",action_key AS "actionKey",
    CASE WHEN observed_at > clock_timestamp()+interval '5 seconds'
      OR CASE WHEN provider='yfinance' THEN fetched_at ELSE observed_at END < clock_timestamp()-interval '60 seconds'
      OR fetched_at > clock_timestamp()+interval '5 seconds' THEN 'stale' ELSE 'fresh' END AS quality
    FROM public.latest_quotes WHERE instrument_id=$1`, [id,instrument.currency])).rows[0] ?? null;
  if (row && instrument.paused) row.quality = 'unavailable';
  return { quote: row, quality: row?.quality ?? 'unavailable', unavailableReason: instrument.paused ? 'CORPORATE_ACTION_REVIEW' : instrument.unavailableReason ?? (row ? null : 'NO_OBSERVATION') };
}
export async function readHistory(pool: Pool, id: string, provider = getProvider(), options: HistoryOptions = {}): Promise<{ items: ProviderBar[]; currency: Currency; quality: string; nextCursor: null }> {
  const instrument = await readInstrument(pool, id);
  if (instrument.provider !== provider.name) return { items: [], currency: instrument.currency, quality: 'unavailable', nextCursor: null };
  let raw: ProviderBar[];
  try { raw = await bounded(provider.history(instrument, options)); } catch { return { items: [], currency: instrument.currency, quality: 'unavailable', nextCursor: null }; }
  const bars = raw.slice(-2000).filter(b => timestamp(b.observedAt) && [b.open,b.high,b.low,b.close].every(positive) && /^\d{1,20}$/.test(b.volume));
  const result = await pool.query<ProviderBar>(`SELECT b->>'observedAt' AS "observedAt",((b->>'open')::numeric*$2::numeric)::numeric(20,8)::text AS open,
    ((b->>'high')::numeric*$2::numeric)::numeric(20,8)::text AS high,((b->>'low')::numeric*$2::numeric)::numeric(20,8)::text AS low,
    ((b->>'close')::numeric*$2::numeric)::numeric(20,8)::text AS close,b->>'volume' AS volume
    FROM jsonb_array_elements($1::jsonb) b
    WHERE (b->>'low')::numeric <= least((b->>'open')::numeric,(b->>'close')::numeric)
    AND (b->>'high')::numeric >= greatest((b->>'open')::numeric,(b->>'close')::numeric)
    AND (b->>'high')::numeric*$2::numeric <= 999999999999.99999999 ORDER BY b->>'observedAt'`, [JSON.stringify(bars),instrument.multiplier]);
  return { items: result.rows, currency: instrument.currency, quality: result.rows.length ? 'known' : 'unavailable', nextCursor: null };
}
export async function readFxRates(pool: Pool, provider?: MarketProvider) {
  if (provider) {
    const client = await pool.connect(); let locked = false; let discard = false;
    try {
      locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(1480963204) AS locked')).rows[0]!.locked;
      if (locked) for (const currency of ['INR','USD','GBP','EUR','JPY','HKD'] as Currency[]) {
        const recent = (await client.query(`SELECT 1 FROM public.latest_fx_rates WHERE currency=$1 AND provider=$2 AND fetched_at>clock_timestamp()-interval '15 seconds'
          AND (provider='yfinance' OR observed_at>clock_timestamp()-interval '24 hours')`, [currency,provider.name])).rowCount;
        if (!recent) await persistFx(client,currency,provider);
      }
    } finally {
      if (locked) { try { await client.query('SELECT pg_advisory_unlock(1480963204)'); } catch { discard = true; } }
      client.release(discard);
    }
  }
  return { items: (await pool.query(`SELECT currency,rate,provider,
    to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt",
    to_char(fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "fetchedAt",
    CASE WHEN CASE WHEN provider='yfinance' THEN fetched_at ELSE observed_at END < clock_timestamp()-interval '24 hours'
      OR observed_at > clock_timestamp()+interval '5 seconds' OR fetched_at > clock_timestamp()+interval '5 seconds' THEN 'stale' ELSE 'fresh' END AS quality
    FROM public.latest_fx_rates WHERE ($1::text IS NULL OR provider=$1) ORDER BY currency`,[provider?.name ?? null])).rows, baseCurrency: 'INR' };
}
