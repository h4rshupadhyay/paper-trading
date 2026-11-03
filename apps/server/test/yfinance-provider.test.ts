import { expect, it, vi } from 'vitest';
import { YfinanceProvider } from '../src/modules/market-data/yfinance-provider.js';
import type { Instrument } from '../src/modules/market-data/provider.js';

const instrument:Instrument={id:'probe',symbol:'VOD.L',name:'Vodafone',exchange:'LSE',currency:'GBP',multiplier:'0.01000000',kind:'EQUITY',tradable:true,paused:false,provider:'yfinance',unavailableReason:null};
const source={...instrument,multiplier:'0.01'};
const quote={rawPrice:'117.123456789123',rawCurrency:'GBp',observedAt:'2026-11-01T12:00:00Z',session:'UNKNOWN',actionKey:'yfinance-raw'};
function client(body:unknown,status=200){return new YfinanceProvider('http://market-data:8000',async()=>new Response(JSON.stringify(body),{status}));}

it('consumes yfinance source prices as decimal strings with original observation time and pence units',async()=>{
  expect(await client({instrument:source,quote}).quote(instrument)).toEqual(quote);
  expect((await client({items:[source]}).search('VOD'))[0]).toMatchObject({symbol:'VOD.L',currency:'GBP',multiplier:'0.01',tradable:true});
});
it('rejects conflicting source units, symbols and invalid prices rather than returning a fallback',async()=>{
  await expect(client({instrument:{...source,currency:'USD'},quote}).quote(instrument)).rejects.toThrow();
  await expect(client({instrument:{...source,symbol:'OTHER'},quote}).quote(instrument)).rejects.toThrow();
  for(const rawPrice of ['0','NaN','-1',null,12])await expect(client({instrument:source,quote:{...quote,rawPrice}}).quote(instrument)).rejects.toThrow();
  await expect(client({instrument:source,quote:{...quote,rawCurrency:'GBP'}}).quote(instrument)).rejects.toThrow();
});
it('keeps indices view-only and refuses wrong-currency FX responses',async()=>{
  const response=await client({items:[{...source,symbol:'^FTSE',kind:'INDEX',tradable:true}]}).search('FTSE');
  expect(response[0]).toMatchObject({tradable:false,unavailableReason:'VIEW_ONLY_INDEX'});
  expect(await client({currency:'GBP',rate:'127.216200000000',observedAt:quote.observedAt}).fx('GBP')).toEqual({rate:'127.216200000000',observedAt:quote.observedAt});
  await expect(client({currency:'USD',rate:'127',observedAt:quote.observedAt}).fx('GBP')).rejects.toThrow();
});
it('forwards raw chart options and propagates sidecar outages',async()=>{
  let requested='';
  const provider=new YfinanceProvider('http://market-data:8000',async url=>{
    requested=String(url);
    return new Response(JSON.stringify({instrument:source,items:[{observedAt:quote.observedAt,open:'116',high:'118',low:'115',close:'117',volume:'9007199254740993'}]}));
  });
  expect((await provider.history(instrument,{period:'1y',interval:'1wk'}))[0]).toMatchObject({close:'117',volume:'9007199254740993'});
  const url=new URL(requested);expect(url.searchParams.get('period')).toBe('1y');expect(url.searchParams.get('interval')).toBe('1wk');
  await expect(client({},503).quote(instrument)).rejects.toThrow(/503/);
  expect(()=>new YfinanceProvider('file:///etc/passwd')).toThrow();
});

it('validates statistics units, nullable metrics, signed P/E and metadata without floating conversions',async()=>{
  const statistics={open:'123.5',dayHigh:'125',dayLow:'120',previousClose:'122',volume:'0',averageVolume:'9007199254740993',marketCap:'123456789',trailingPE:'-5.25',fiftyTwoWeekHigh:'160',fiftyTwoWeekLow:null};
  const body={symbol:'VOD.L',rawCurrency:'GBp',statistics,sector:'Telecom',industry:null,description:null};
  expect(await client(body).statistics(instrument)).toMatchObject({rawCurrency:'GBp',statistics,sector:'Telecom'});
  for(const invalid of [{...body,rawCurrency:'GBP'},{...body,symbol:'OTHER'},{...body,statistics:{...statistics,volume:'1.5'}},{...body,statistics:{...statistics,open:'NaN'}}]){
    await expect(client(invalid).statistics(instrument)).rejects.toThrow();
  }
});

it('absorbs a bounded startup burst without dropping instrument discovery while limiting upstream concurrency',async()=>{
  let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r});
  let active=0,peak=0;
  const provider=new YfinanceProvider('http://market-data:8000',async()=>{
    active++;peak=Math.max(peak,active);await gate;active--;
    return new Response(JSON.stringify({items:[source]}));
  });
  const calls=[provider.search('one'),provider.search('two'),provider.search('three')];
  // Attach rejection handlers before yielding; failing admission must not go unhandled.
  const done=Promise.allSettled(calls);
  release();const results=await done;
  expect(peak).toBeLessThanOrEqual(2);
  expect(results.map(r=>r.status)).toEqual(['fulfilled','fulfilled','fulfilled']);
});

it('expires waiting calls without leaking admission capacity',async()=>{
  vi.useFakeTimers();
  let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r});
  const provider=new YfinanceProvider('http://market-data:8000',async()=>{await gate;return new Response(JSON.stringify({items:[source]}))});
  const active=[provider.search('one'),provider.search('two')];
  const queued=provider.fx('GBP');
  const verdict=queued.then(()=> 'fulfilled',()=> 'expired');
  try {
    await vi.advanceTimersByTimeAsync(6501);
    expect(await verdict).toBe('expired');
    release();await Promise.all(active);
    expect((await provider.search('recovered'))[0]?.symbol).toBe('VOD.L');
  } finally {release();vi.useRealTimers();}
});
it('rejects excess waiting work while completing the admitted burst',async()=>{
  let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r});
  const provider=new YfinanceProvider('http://market-data:8000',async()=>{await gate;return new Response(JSON.stringify({items:[source]}))});
  const admitted=Array.from({length:10},(_,i)=>provider.search(String(i)));
  const results=Promise.allSettled(admitted);
  await expect(provider.search('overflow')).rejects.toThrow(/pending limit/);
  release();expect((await results).every(item=>item.status==='fulfilled')).toBe(true);
});
