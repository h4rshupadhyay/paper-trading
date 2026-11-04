import {z} from 'zod';

export const demoSymbols=['AAPL','MSFT','RELIANCE.NS'] as const;
export type DemoSymbol=typeof demoSymbols[number];
const decimal=z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,8})?$/).refine(s=>/[1-9]/.test(s));
const timestamp=z.iso.datetime({offset:true});
const bar=z.object({sessionDate:z.iso.date(),closedAt:timestamp,availableAt:timestamp,close:decimal}).strict();
const series=z.object({currency:z.enum(['USD','INR']),items:z.array(bar).min(18).max(40)}).strict();
const schema=z.object({source:z.literal('yfinance'),fetchedAt:timestamp,corporateActions:z.literal('none'),series:z.object({
  AAPL:series,MSFT:series,'RELIANCE.NS':series,'USDINR=X':series,
}).strict()}).strict();
export type DemoHistory=z.infer<typeof schema>;
export type DemoBar=z.infer<typeof bar>;
export type DemoTrade={symbol:DemoSymbol;side:'BUY'|'SELL';quantity:string;price:string;fx:string;at:string;fxAt:string;sessionDate:string};
export type DemoSample={at:string;prices:Record<DemoSymbol,string>;fx:string;observedFrom:string;observedTo:string};
export type PreparedDemo={history:DemoHistory;trades:DemoTrade[];samples:DemoSample[];reference:Record<DemoSymbol,string>;fx:string;openingAt:string;provenance:string};
const day=86400000;
function fail():never{throw new Error('Demo history is incomplete, stale or inconsistent; no synthetic fallback is allowed');}
function asOf(items:DemoBar[],at:string):DemoBar{
  const time=Date.parse(at);
  const found=items.findLast(b=>Date.parse(b.availableAt)<=time);
  if(!found||time-Date.parse(found.closedAt)>4*day)fail();
  return found;
}

export function prepareDemoHistory(value:unknown,now=Date.now()):PreparedDemo{
  const parsed=schema.safeParse(value);if(!parsed.success)fail();
  const history=parsed.data,fetched=Date.parse(history.fetchedAt);
  if(fetched>now+5000||now-fetched>day)fail();
  for(const [symbol,s] of Object.entries(history.series)){
    if(s.currency!==(symbol==='AAPL'||symbol==='MSFT'?'USD':'INR'))fail();
    let previous='';let previousClosed=0;let previousAvailable=0;
    for(const b of s.items){
      if(b.sessionDate<=previous||Date.parse(b.closedAt)<=previousClosed||Date.parse(b.availableAt)<=previousAvailable||Date.parse(b.closedAt)>Date.parse(b.availableAt)||Date.parse(b.availableAt)>fetched
        ||fetched-Date.parse(b.closedAt)>45*day||Date.parse(b.closedAt)<Date.parse(`${b.sessionDate}T00:00:00Z`))fail();
      if(symbol!=='USDINR=X'&&([0,6].includes(new Date(`${b.sessionDate}T12:00:00Z`).getUTCDay())||b.closedAt.slice(0,10)!==b.sessionDate))fail();
      previous=b.sessionDate;previousClosed=Date.parse(b.closedAt);previousAvailable=Date.parse(b.availableAt);
    }
    if(fetched-Date.parse(s.items.at(-1)!.closedAt)>7*day)fail();
  }
  const dates=history.series.AAPL.items.map(b=>b.sessionDate).filter(date=>demoSymbols.every(s=>history.series[s].items.some(b=>b.sessionDate===date)));
  if(dates.length<18)fail();
  const specs=[['AAPL','BUY','10',.1],['MSFT','BUY','4',.25],['RELIANCE.NS','BUY','20',.4],['AAPL','SELL','3',.6],['RELIANCE.NS','SELL','5',.8]] as const;
  const trades=specs.map(([symbol,side,quantity,fraction]):DemoTrade=>{
    const sessionDate=dates[Math.floor((dates.length-1)*fraction)]!;
    const b=history.series[symbol].items.find(b=>b.sessionDate===sessionDate)!;
    const fx=symbol==='RELIANCE.NS'?null:asOf(history.series['USDINR=X'].items,b.closedAt);
    return {symbol,side,quantity,price:b.close,fx:fx?.close??'1',at:b.closedAt,fxAt:fx?.closedAt??b.closedAt,sessionDate};
  });
  const openingAt=`${history.series.AAPL.items[0]!.sessionDate}T00:00:00Z`;
  const samples:DemoSample[]=[];
  for(const date of dates){
    const at=new Date(Math.max(...demoSymbols.map(symbol=>Date.parse(history.series[symbol].items.find(b=>b.sessionDate===date)!.availableAt)))).toISOString();
    if(Date.parse(at)>fetched||at<trades[0]!.at)continue;
    const observations=demoSymbols.map(s=>asOf(history.series[s].items,at));
    const fx=asOf(history.series['USDINR=X'].items,at);
    const times=[...observations.map(b=>b.closedAt),fx.closedAt].sort();
    samples.push({at,prices:Object.fromEntries(demoSymbols.map((s,i)=>[s,observations[i]!.close])) as Record<DemoSymbol,string>,fx:fx.close,observedFrom:times[0]!,observedTo:times.at(-1)!});
  }
  if(!samples.length)fail();
  const reference=Object.fromEntries(demoSymbols.map(s=>[s,history.series[s].items.at(-1)!.close])) as Record<DemoSymbol,string>;
  const fx=asOf(history.series['USDINR=X'].items,history.fetchedAt).close;
  const provenance=`Simulated paper trades based on actual yfinance unadjusted daily closing prices, not recorded market executions. Retrieved ${history.fetchedAt}. USD/INR uses the latest completed FX daily bar available before each fill; never a future rate. Daily bars are admitted only after the next source-local midnight. Equity timestamps use regular session end (conservative on early closes). No splits or dividends occurred in the source window. Historical valuations are backfilled and marked stale.\n\n${trades.map(t=>`${t.sessionDate}: ${t.side} ${t.quantity} ${t.symbol} at ${t.price} ${t.symbol==='RELIANCE.NS'?'INR':'USD'}; INR FX ${t.fx}, FX observation ${t.fxAt}.`).join('\n')}`;
  return {history,trades,samples,reference,fx,openingAt,provenance};
}
