import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { YahooProvider, type Instrument } from '../src/modules/market-data/provider.js';
import { getProvider } from '../src/modules/market-data/service.js';
const instrument: Instrument = { id: 'probe',symbol:'VOD.L',name:'Vodafone',exchange:'LSE',currency:'GBP',multiplier:'0.01',kind:'EQUITY',tradable:false,paused:false,provider:'yahoo',unavailableReason:'LIVE_MARKET_NOT_VALIDATED' };
const payload = `{"chart":{"result":[{"meta":{"symbol":"VOD.L","currency":"GBp","exchangeName":"LSE","instrumentType":"EQUITY","shortName":"Vodafone","regularMarketPrice":117.123456789123,"regularMarketTime":1793623123},"timestamp":[1793536723],"indicators":{"quote":[{"open":[116.1],"high":[118.2],"low":[115.3],"close":[117.4],"volume":[9007199254740993]}]}}]}}`;

// Catch treating a discovered multiplier as major units, numeric JSON loss, adjusted history usage.
it('preserves exact source JSON decimals and accepts metadata pence units for quote and unadjusted history', async () => {
  const provider = new YahooProvider(async () => new Response(payload));
  expect(await provider.quote(instrument)).toMatchObject({ rawPrice:'117.123456789123',rawCurrency:'GBp',session:'UNKNOWN' });
  expect((await provider.history(instrument))[0]).toMatchObject({ open:'116.1',high:'118.2',low:'115.3',close:'117.4',volume:'9007199254740993' });
});
it('never marks live discovery tradable without market acceptance', async () => {
  const provider = new YahooProvider(async () => new Response(payload));
  expect((await provider.search(''))[0]).toMatchObject({ currency:'GBP',multiplier:'0.01',tradable:false,unavailableReason:'LIVE_MARKET_NOT_VALIDATED' });
});
it('rejects provider HTTP failures and bounds request count', async () => {
  const failed = new YahooProvider(async () => new Response('', { status:429 }));
  await expect(failed.quote(instrument)).rejects.toThrow('HTTP 429');
  const provider = new YahooProvider(async () => new Response(payload));
  for (let i=0;i<24;i++) await provider.quote({ ...instrument,multiplier:'0.01000000' });
  await expect(provider.quote(instrument)).rejects.toThrow('call limit');
});
let server: Server | undefined;
afterEach(async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server=undefined; });
it('aborts an unresponsive native fetch and restores provider capacity after timeout', async () => {
  server = createServer(() => {}); await new Promise<void>(resolve => server!.listen(0,'127.0.0.1',resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Invalid server');
  const local = `http://127.0.0.1:${address.port}`;
  const provider = new YahooProvider((_url, options) => fetch(local,options),30);
  await expect(provider.quote(instrument)).rejects.toThrow(/timeout|aborted/i);
  await expect(provider.quote(instrument)).rejects.toThrow(/timeout|aborted/i);
});
it('prohibits fixture provider in production and rejects unknown modes', () => {
  const priorMode=process.env.MARKET_PROVIDER, priorEnv=process.env.NODE_ENV;
  try {
    process.env.MARKET_PROVIDER='fixture'; process.env.NODE_ENV='production'; expect(()=>getProvider()).toThrow(/forbidden/);
    process.env.MARKET_PROVIDER='missing'; expect(()=>getProvider()).toThrow(/Unsupported/);
  } finally { if(priorMode === undefined) delete process.env.MARKET_PROVIDER; else process.env.MARKET_PROVIDER=priorMode; if(priorEnv===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=priorEnv; }
});
it('passes the requested unadjusted chart range and interval to the upstream endpoint', async () => {
  const provider = new YahooProvider(async url => new Response(String(url).includes('range=1y') && String(url).includes('interval=1wk') ? payload : '', {status:String(url).includes('range=1y') && String(url).includes('interval=1wk') ? 200 : 400}));
  expect((await provider.history(instrument,{period:'1y',interval:'1wk'}))[0]?.close).toBe('117.4');
});
it('returns fixture chart observations within the selected interval and range', async () => {
  const {FixtureProvider} = await import('../src/modules/market-data/provider.js');
  const fixture=new FixtureProvider();
  const intraday=await fixture.history(instrument,{period:'1d',interval:'5m'});
  expect(intraday.length).toBe(288);
  expect(Date.now()-Date.parse(intraday[0]!.observedAt)).toBeLessThan(86400000);
  expect(Date.parse(intraday[1]!.observedAt)-Date.parse(intraday[0]!.observedAt)).toBe(300000);
  const long=await fixture.history(instrument,{period:'5y',interval:'1wk'});
  expect(Date.now()-Date.parse(long[0]!.observedAt)).toBeGreaterThan(4*365*86400000);
});
