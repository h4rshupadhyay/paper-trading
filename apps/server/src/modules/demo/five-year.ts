import {z} from 'zod';
import type {DemoSymbol,DemoTrade,DemoSample} from './history.js';
import type {HistoricalAction} from './five-year-accounting.js';
const symbols=['AAPL','MSFT','RELIANCE.NS'] as const;
const positive=z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,8})?$/).refine(s=>/[1-9]/.test(s));
const zeroable=z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,8})?$/);
const timestamp=z.iso.datetime({offset:true});
const bar=z.object({sessionDate:z.iso.date(),closedAt:timestamp,availableAt:timestamp,close:positive,dividend:zeroable,split:positive}).strict();
const series=z.object({currency:z.enum(['INR','USD']),items:z.array(bar).min(1000).max(1400)}).strict();
const schema=z.object({version:z.literal(3),source:z.literal('yfinance'),priceBasis:z.literal('contemporaneous'),fetchedAt:timestamp,
  series:z.object({AAPL:series,MSFT:series,'RELIANCE.NS':series,'USDINR=X':series}).strict()}).strict();
export type FiveYearHistory=z.infer<typeof schema>;
type Bar=z.infer<typeof bar>;
export type FiveYearPrepared={history:FiveYearHistory;trades:DemoTrade[];actions:HistoricalAction[];samples:DemoSample[];reference:Record<DemoSymbol,string>;fx:string;openingAt:string;provenance:string};
const day=86400000;
function fail():never{throw new Error('Five-year source history is incomplete, stale or inconsistent');}
function asOf(items:Bar[],at:string):Bar|undefined{
  const time=Date.parse(at),found=items.findLast(b=>Date.parse(b.availableAt)<=time);
  return found&&time-Date.parse(found.availableAt)<=7*day?found:undefined;
}
export function prepareFiveYearHistory(value:unknown,now=Date.now()):FiveYearPrepared{
  const result=schema.safeParse(value);if(!result.success)fail();const history=result.data,fetched=Date.parse(history.fetchedAt);
  if(fetched>now+5000||now-fetched>day)fail();
  for(const [symbol,s] of Object.entries(history.series)){
    if(s.currency!==(symbol==='AAPL'||symbol==='MSFT'?'USD':'INR'))fail();
    let previous='',previousTime=0;
    for(const b of s.items){
      if(b.sessionDate<=previous||Date.parse(b.availableAt)<=previousTime||Date.parse(b.closedAt)>Date.parse(b.availableAt)||Date.parse(b.availableAt)>fetched||fetched-Date.parse(b.closedAt)>1840*day)fail();
      if(symbol==='USDINR=X'&&(Number(b.dividend)!==0||Number(b.split)!==1))fail();
      previous=b.sessionDate;previousTime=Date.parse(b.availableAt);
    }
    if(fetched-Date.parse(s.items.at(-1)!.availableAt)>7*day||fetched-Date.parse(s.items[0]!.closedAt)<1800*day)fail();
  }
  const fxItems=history.series['USDINR=X'].items;
  const common=history.series.AAPL.items.filter(b=>symbols.every(s=>history.series[s].items.some(x=>x.sessionDate===b.sessionDate))&&asOf(fxItems,b.closedAt));
  const quarters=new Map<string,string>();
  for(const b of common){const date=new Date(b.sessionDate),key=`${date.getUTCFullYear()}-${Math.floor(date.getUTCMonth()/3)}`;if(!quarters.has(key))quarters.set(key,b.sessionDate);}
  if(quarters.size<20)fail();
  const trades:DemoTrade[]=[];
  const add=(symbol:DemoSymbol,side:'BUY'|'SELL',quantity:string,date:string)=>{
    const b=history.series[symbol].items.find(b=>b.sessionDate===date)!;const fx=symbol==='RELIANCE.NS'?undefined:asOf(fxItems,b.closedAt);if(symbol!=='RELIANCE.NS'&&!fx)fail();
    trades.push({symbol,side,quantity,price:b.close,fx:fx?.close??'1',at:b.closedAt,fxAt:fx?.closedAt??b.closedAt,sessionDate:date});
  };
  let reliance=false;
  [...quarters.values()].forEach((date,n)=>{
    if(n===0){add('AAPL','BUY','10',date);add('MSFT','BUY','4',date);}
    else{
      if(n%2===0)add('AAPL','BUY','1',date);
      if(n%4===1)add('MSFT','BUY','1',date);
      if(n%4===3)add('AAPL','SELL','1',date);
      if(n%4===0)add('MSFT','SELL','1',date);
    }
    // JFSL demerger is not a Yahoo split/dividend. No exposure before it.
    if(!reliance&&date>'2023-07-20'){add('RELIANCE.NS','BUY','10',date);reliance=true;}
    else if(reliance&&n%4===2)add('RELIANCE.NS','SELL','1',date);
  });
  const actions:HistoricalAction[]=[];
  for(const symbol of symbols)for(const b of history.series[symbol].items){
    const at=new Date(Date.parse(b.closedAt)-(symbol==='RELIANCE.NS'?15.5:16)*3600000).toISOString();
    if(Number(b.split)!==1)actions.push({symbol,kind:'SPLIT',at,sessionDate:b.sessionDate,factor:b.split,perShare:'0',fx:'1',fxAt:at});
    if(Number(b.dividend)!==0){
      const fx=symbol==='RELIANCE.NS'?undefined:asOf(fxItems,at);
      if(symbol!=='RELIANCE.NS'&&!fx){if(at<trades[0]!.at)continue;fail();}
      actions.push({symbol,kind:'DIVIDEND',at,sessionDate:b.sessionDate,factor:'1',perShare:b.dividend,fx:fx?.close??'1',fxAt:fx?.closedAt??at});
    }
  }
  const dates=[...new Set(symbols.flatMap(s=>history.series[s].items.map(b=>b.sessionDate)))].sort();
  const samples:DemoSample[]=[];
  for(const date of dates){
    const next=new Date(`${date}T06:00:00Z`);next.setUTCDate(next.getUTCDate()+1);const at=next.toISOString();if(Date.parse(at)>fetched)continue;
    const observations=symbols.map(s=>asOf(history.series[s].items,at)),fx=asOf(fxItems,at);if(observations.some(b=>!b)||!fx)continue;
    // A carried pre-action close is in the old economic state. Wait for
    // an ex-date close rather than combining split shares/dividend cash with it.
    if(symbols.some((symbol,n)=>actions.some(action=>action.symbol===symbol&&Date.parse(action.at)>Date.parse(observations[n]!.closedAt)&&Date.parse(action.at)<=Date.parse(at))))continue;
    const times=[...observations.map(b=>b!.closedAt),fx.closedAt].sort();
    samples.push({at,prices:Object.fromEntries(symbols.map((s,n)=>[s,observations[n]!.close])) as Record<DemoSymbol,string>,fx:fx.close,observedFrom:times[0]!,observedTo:times.at(-1)!});
  }
  if(samples.length<1000)fail();
  const reference=Object.fromEntries(symbols.map(s=>[s,history.series[s].items.at(-1)!.close])) as Record<DemoSymbol,string>;
  const fx=asOf(fxItems,history.fetchedAt);if(!fx)fail();
  const openingAt=history.series.AAPL.items[0]!.sessionDate+'T00:00:00Z';
  const provenance=`Five-year simulated paper trading using actual yfinance daily closes, historical USD/INR and reported splits/dividends. Source window ${history.series.AAPL.items[0]!.sessionDate} to ${history.series.AAPL.items.at(-1)!.sessionDate}; fetched ${history.fetchedAt}. Historical Close and dividends restored to contemporaneous share units before replay. Gross dividend cash credits are simulated on ex-dates, not actual payable dates; no tax, fees or reinvestment. Splits preserve total cost. RELIANCE exposure starts after the July 2023 JFSL demerger. Daily backfilled valuations are stale historical samples; no invented intraday path. ${trades.length} trades scheduled across ${quarters.size} quarters. Full source archive and digest retained by the seed command.`;
  return {history,trades,actions,samples,reference,fx:fx.close,openingAt,provenance};
}
