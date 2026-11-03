import { createHash } from 'node:crypto';

export type Currency = 'INR' | 'USD' | 'GBP' | 'EUR' | 'JPY' | 'HKD';
export type Session = 'REGULAR' | 'CLOSED' | 'UNKNOWN';
export type ProviderInstrument = {
  symbol: string; name: string; exchange: string; currency: Currency;
  multiplier: string; kind: 'EQUITY' | 'INDEX'; tradable: boolean; unavailableReason: string | null;
};
export type Instrument = ProviderInstrument & { id: string; paused: boolean; provider: string };
export type ProviderQuote = { rawPrice: string; rawCurrency: string; observedAt: string; session: Session; actionKey: string };
export type ProviderFx = { rate: string; observedAt: string };
export type ProviderBar = { observedAt: string; open: string; high: string; low: string; close: string; volume: string };
export type HistoryOptions = { period?: '1d'|'5d'|'1mo'|'3mo'|'6mo'|'1y'|'5y'; interval?: '5m'|'15m'|'1d'|'1wk'|'1mo' };
export interface MarketProvider {
  readonly name: string;
  statistics?(instrument: Instrument): Promise<ProviderStatistics>;
  search(query: string): Promise<ProviderInstrument[]>;
  quote(instrument: Instrument): Promise<ProviderQuote>;
  fx(currency: Currency): Promise<ProviderFx>;
  history(instrument: Instrument, options?: HistoryOptions): Promise<ProviderBar[]>;
}

const catalogue: ProviderInstrument[] = [
  ['AAPL','Apple Inc.','NMS','USD','1','EQUITY'],
  ['MSFT','Microsoft Corporation','NMS','USD','1','EQUITY'],
  ['RELIANCE.NS','Reliance Industries','NSI','INR','1','EQUITY'],
  ['TCS.NS','Tata Consultancy Services','NSI','INR','1','EQUITY'],
  ['VOD.L','Vodafone Group','LSE','GBP','0.01','EQUITY'],
  ['SAP.DE','SAP SE','GER','EUR','1','EQUITY'],
  ['7203.T','Toyota Motor','JPX','JPY','1','EQUITY'],
  ['0700.HK','Tencent Holdings','HKG','HKD','1','EQUITY'],
  ['^GSPC','S&P 500','SNP','USD','1','INDEX'],
  ['^NSEI','Nifty 50','NSI','INR','1','INDEX'],
  ['^FTSE','FTSE 100','FTI','GBP','1','INDEX'],
  ['^GDAXI','DAX','GER','EUR','1','INDEX'],
  ['^N225','Nikkei 225','OSA','JPY','1','INDEX'],
  ['^HSI','Hang Seng','HKG','HKD','1','INDEX'],
].map(([symbol,name,exchange,currency,multiplier,kind]) => ({ symbol: symbol!, name: name!, exchange: exchange!, currency: currency as Currency, multiplier: multiplier!, kind: kind as 'EQUITY'|'INDEX', tradable: kind === 'EQUITY', unavailableReason: kind === 'INDEX' ? 'VIEW_ONLY_INDEX' : null }));

/** Explicit simulator data only. Never selected as a fallback after an outage. */
export class FixtureProvider implements MarketProvider {
  readonly name = 'fixture';
  async search(query: string): Promise<ProviderInstrument[]> {
    const q = query.toLocaleLowerCase('en-US');
    return catalogue.filter(i => `${i.symbol} ${i.name}`.toLowerCase().includes(q)).map(i => ({ ...i }));
  }
  async quote(instrument: Instrument): Promise<ProviderQuote> {
    return { rawPrice: instrument.multiplier === '0.01000000' || instrument.multiplier === '0.01' ? '15000' : '150', rawCurrency: instrument.multiplier === '0.01000000' || instrument.multiplier === '0.01' ? 'GBp' : instrument.currency, observedAt: new Date().toISOString(), session: 'REGULAR', actionKey: 'fixture-v1' };
  }
  async fx(currency: Currency): Promise<ProviderFx> {
    return { rate: { INR: '1', USD: '83', GBP: '105', EUR: '90', JPY: '0.55', HKD: '10.6' }[currency], observedAt: new Date().toISOString() };
  }
  async history(instrument: Instrument, options: HistoryOptions = {}): Promise<ProviderBar[]> {
    const pence = instrument.multiplier === '0.01000000' || instrument.multiplier === '0.01';
    const day = 86400000;
    const duration = { '1d':day,'5d':5*day,'1mo':30*day,'3mo':90*day,'6mo':180*day,'1y':365*day,'5y':5*365*day }[options.period ?? '3mo'];
    const interval = { '5m':300000,'15m':900000,'1d':day,'1wk':7*day,'1mo':30*day }[options.interval ?? '1d'];
    const count = Math.min(2000,Math.ceil(duration/interval));
    const end = Date.now();
    return Array.from({ length: count }, (_, i) => ({ observedAt: new Date(end - (count - 1 - i) * interval).toISOString(), open: pence ? '14900' : '149', high: pence ? '15100' : '151', low: pence ? '14800' : '148', close: pence ? '15000' : '150', volume: '1000000' }));
  }
}

const currencies = new Set(['INR','USD','GBP','EUR','JPY','HKD']);
const unvalidated = 'LIVE_MARKET_NOT_VALIDATED';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider response');
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('Invalid provider array'); return value; }
function field(value: unknown): string { if (typeof value !== 'string' || !value.length) throw new Error('Invalid provider field'); return value; }
function epoch(value: unknown): string { const seconds = Number(field(value)); if (!Number.isSafeInteger(seconds)) throw new Error('Invalid timestamp'); return new Date(seconds * 1000).toISOString(); }
function first(value: unknown): Record<string, unknown> { return object(list(value)[0]); }

/** Preserve raw JSON numeric lexemes: prices never pass through JavaScript Number. */
export function parseProviderJson(body: string): unknown {
  return JSON.parse(body.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => token.startsWith('"') ? token : JSON.stringify(token)));
}

/** Yahoo's public endpoints are display-only until each market passes acceptance. */
export class YahooProvider implements MarketProvider {
  readonly name = 'yahoo';
  private active = 0;
  private calls: number[] = [];
  constructor(private readonly request: typeof fetch = fetch, private readonly timeoutMs = 2500) {}
  private async get(url: string): Promise<Record<string, unknown>> {
    const now = Date.now(); this.calls = this.calls.filter(t => now - t < 60000);
    if (this.active >= 2 || this.calls.length >= 24) throw new Error('Provider call limit');
    this.active++; this.calls.push(now);
    try {
      const response = await this.request(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { 'User-Agent': 'paper-trading/1.0', Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error('Provider response too large');
      return object(parseProviderJson(text));
    } finally { this.active--; }
  }
  private async chart(symbol: string, history = false, options: HistoryOptions = {}): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ range: history ? options.period ?? '3mo' : '5d', interval: history ? options.interval ?? '1d' : '1m', events: 'div,splits', includePrePost: 'false' });
    return first(object((await this.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`)).chart).result);
  }
  private metadata(result: Record<string, unknown>): ProviderInstrument {
    const meta = object(result.meta); const rawCurrency = field(meta.currency);
    const currency = rawCurrency === 'GBp' ? 'GBP' : rawCurrency;
    if (!currencies.has(currency)) throw new Error('Unsupported currency');
    const kind = field(meta.instrumentType); if (!['EQUITY','INDEX'].includes(kind)) throw new Error('Unsupported instrument');
    return { symbol: field(meta.symbol), name: field(meta.longName ?? meta.shortName ?? meta.symbol), exchange: field(meta.exchangeName), currency: currency as Currency, multiplier: rawCurrency === 'GBp' ? '0.01' : '1', kind: kind as 'EQUITY'|'INDEX', tradable: false, unavailableReason: kind === 'INDEX' ? 'VIEW_ONLY_INDEX' : unvalidated };
  }
  async search(query: string): Promise<ProviderInstrument[]> {
    // A bounded metadata probe validates currency and units; search results alone cannot.
    const symbols: string[] = query ? list((await this.get(`https://query1.finance.yahoo.com/v1/finance/search?${new URLSearchParams({ q: query, quotesCount: '4', newsCount: '0' })}`)).quotes).slice(0, 4).flatMap(item => {
      const x = object(item); return ['EQUITY','INDEX'].includes(String(x.quoteType)) && typeof x.symbol === 'string' ? [x.symbol] : [];
    }) : ['AAPL','RELIANCE.NS','VOD.L','SAP.DE','7203.T','0700.HK'];
    const result: ProviderInstrument[] = [];
    for (const symbol of symbols) { try { result.push(this.metadata(await this.chart(symbol))); } catch { /* failed metadata never becomes an instrument */ } }
    return result;
  }
  async quote(instrument: Instrument): Promise<ProviderQuote> {
    const result = await this.chart(instrument.symbol); const meta = object(result.meta); const canonical = this.metadata(result);
    if (canonical.currency !== instrument.currency || canonical.multiplier !== (['0.01000000','0.01'].includes(instrument.multiplier) ? '0.01' : '1')) throw new Error('Unit metadata changed');
    // Calendar windows cannot prove a current regular session or complete action history.
    // UNKNOWN intentionally prevents all execution, while still exposing known observations.
    return { rawPrice: field(meta.regularMarketPrice), rawCurrency: field(meta.currency), observedAt: epoch(meta.regularMarketTime), session: 'UNKNOWN', actionKey: `unvalidated:${createHash('sha256').update(JSON.stringify(result.events ?? {})).digest('hex')}` };
  }
  async fx(currency: Currency): Promise<ProviderFx> {
    if (currency === 'INR') return { rate: '1', observedAt: new Date().toISOString() };
    const meta = object((await this.chart(`${currency}INR=X`)).meta);
    if (meta.currency !== 'INR' || meta.symbol !== `${currency}INR=X`) throw new Error('Invalid FX direction');
    return { rate: field(meta.regularMarketPrice), observedAt: epoch(meta.regularMarketTime) };
  }
  async history(instrument: Instrument, options: HistoryOptions = {}): Promise<ProviderBar[]> {
    const result = await this.chart(instrument.symbol, true, options); const meta = this.metadata(result);
    if (meta.currency !== instrument.currency || meta.multiplier !== (['0.01000000','0.01'].includes(instrument.multiplier) ? '0.01' : '1')) throw new Error('History unit metadata changed');
    const timestamps = list(result.timestamp); const bars = first(object(result.indicators).quote);
    return timestamps.slice(-2000).flatMap((timestamp, index) => {
      // The last 2000 points keep their original positions in provider arrays.
      const offset = Math.max(0, timestamps.length - 2000) + index;
      try { return [{ observedAt: epoch(timestamp), open: field(list(bars.open)[offset]), high: field(list(bars.high)[offset]), low: field(list(bars.low)[offset]), close: field(list(bars.close)[offset]), volume: field(list(bars.volume)[offset]) }]; } catch { return []; }
    });
  }
}

export const statisticFields = ['open','dayHigh','dayLow','previousClose','volume','averageVolume','marketCap','trailingPE','fiftyTwoWeekHigh','fiftyTwoWeekLow'] as const;
export type StatisticField = typeof statisticFields[number];
export type ProviderStatistics = {
  symbol: string; rawCurrency: string; statistics: Record<StatisticField,string|null>;
  sector: string|null; industry: string|null; description: string|null;
};
