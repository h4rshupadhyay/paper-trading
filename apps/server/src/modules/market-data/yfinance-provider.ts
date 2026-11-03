import type { Currency, HistoryOptions, Instrument, MarketProvider, ProviderBar, ProviderFx, ProviderInstrument, ProviderQuote } from './provider.js';

function record(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid yfinance response');
  return value as Record<string,unknown>;
}
function string(value:unknown):string{if(typeof value!=='string'||!value.length)throw new Error('Invalid yfinance field');return value;}
function decimal(value:unknown):string{
  const text=string(value);
  if(!/^(?:0|[1-9]\d{0,19})(?:\.\d{1,24})?$/.test(text)||!/[1-9]/.test(text))throw new Error('Invalid yfinance price');
  return text;
}
function timestamp(value:unknown):string{
  const text=string(value),time=Date.parse(text);
  if(!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)||!Number.isFinite(time)||time<=0||time>Date.now()+5000)throw new Error('Invalid yfinance timestamp');
  return text;
}
function array(value:unknown):unknown[]{if(!Array.isArray(value))throw new Error('Invalid yfinance list');return value;}
function metadata(value:unknown):ProviderInstrument{
  const item=record(value),currency=string(item.currency),kind=string(item.kind),multiplier=string(item.multiplier);
  if(!['INR','USD','GBP','EUR','JPY','HKD'].includes(currency)||!['EQUITY','INDEX'].includes(kind)||!['1','0.01'].includes(multiplier))throw new Error('Invalid yfinance instrument');
  return {symbol:string(item.symbol),name:string(item.name),exchange:string(item.exchange),currency:currency as Currency,multiplier,kind:kind as 'EQUITY'|'INDEX',
    tradable:kind==='EQUITY',unavailableReason:kind==='INDEX'?'VIEW_ONLY_INDEX':null};
}
export class YfinanceMetadataChanged extends Error {}

export class YfinanceProvider implements MarketProvider {
  readonly name='yfinance';
  private readonly url:URL;
  private active=0;
  constructor(url=process.env.YFINANCE_URL??'http://127.0.0.1:8000',private readonly request:typeof fetch=fetch){
    this.url=new URL(url);
    if(!['http:','https:'].includes(this.url.protocol)||this.url.username||this.url.password||this.url.search||this.url.hash||this.url.pathname!=='/')throw new Error('Invalid YFINANCE_URL');
  }
  private async get(path:string,params:Record<string,string>,timeout=6500):Promise<Record<string,unknown>>{
    if(this.active>=2)throw new Error('yfinance concurrency limit');
    this.active++;
    try {
      const url=new URL(path,this.url);url.search=new URLSearchParams(params).toString();
      const response=await this.request(url.href,{signal:AbortSignal.timeout(timeout),headers:{Accept:'application/json'}});
      if(!response.ok)throw new Error(`yfinance HTTP ${response.status}`);
      const body=await response.text();if(body.length>2_000_000)throw new Error('yfinance response too large');
      return record(JSON.parse(body));
    } finally {this.active--;}
  }
  private matching(value:unknown,instrument:Instrument):ProviderInstrument{
    const item=metadata(value);
    if(item.symbol!==instrument.symbol||item.currency!==instrument.currency||item.kind!==instrument.kind
      ||item.multiplier!==(['0.01','0.01000000'].includes(instrument.multiplier)?'0.01':'1'))throw new YfinanceMetadataChanged('yfinance unit metadata changed');
    return item;
  }
  async search(query:string):Promise<ProviderInstrument[]>{
    return array((await this.get('/search',{q:query},19000)).items).slice(0,6).map(metadata);
  }
  async quote(instrument:Instrument):Promise<ProviderQuote>{
    const data=await this.get('/quote',{symbol:instrument.symbol}),item=this.matching(data.instrument,instrument),quote=record(data.quote);
    const rawCurrency=string(quote.rawCurrency);
    if(rawCurrency!==(item.multiplier==='0.01'?'GBp':item.currency))throw new YfinanceMetadataChanged('yfinance raw currency changed');
    if(quote.session!=='UNKNOWN'||quote.actionKey!=='yfinance-raw')throw new Error('Invalid yfinance observation metadata');
    return {rawPrice:decimal(quote.rawPrice),rawCurrency,observedAt:timestamp(quote.observedAt),session:'UNKNOWN',actionKey:'yfinance-raw'};
  }
  async fx(currency:Currency):Promise<ProviderFx>{
    const data=await this.get('/fx',{currency});
    if(data.currency!==currency)throw new Error('yfinance FX currency mismatch');
    return {rate:decimal(data.rate),observedAt:timestamp(data.observedAt)};
  }
  async history(instrument:Instrument,options:HistoryOptions={}):Promise<ProviderBar[]>{
    const data=await this.get('/history',{symbol:instrument.symbol,period:options.period??'3mo',interval:options.interval??'1d'});
    this.matching(data.instrument,instrument);
    return array(data.items).slice(-2000).map(value=>{
      const bar=record(value),volume=string(bar.volume);if(!/^\d{1,20}$/.test(volume))throw new Error('Invalid yfinance volume');
      return {observedAt:timestamp(bar.observedAt),open:decimal(bar.open),high:decimal(bar.high),low:decimal(bar.low),close:decimal(bar.close),volume};
    });
  }
}
