import { expect, it } from 'vitest';
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
