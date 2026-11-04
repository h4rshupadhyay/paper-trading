import type {FiveYearHistory} from '../../src/modules/demo/five-year.js';
export function fiveYearHistory():FiveYearHistory{
  const now=new Date(),start=new Date(now);start.setUTCFullYear(start.getUTCFullYear()-5);start.setUTCHours(0,0,0,0);
  const series={} as FiveYearHistory['series'];
  for(const symbol of ['AAPL','MSFT','RELIANCE.NS','USDINR=X'] as const){
    const items=[];
    for(let date=new Date(start);date.toISOString().slice(0,10)<now.toISOString().slice(0,10);date=new Date(date.getTime()+86400000)){
      if([0,6].includes(date.getUTCDay()))continue;
      const sessionDate=date.toISOString().slice(0,10),next=new Date(date.getTime()+86400000).toISOString().slice(0,10);
      const availableAt=next+(symbol==='AAPL'||symbol==='MSFT'?'T05:00:00Z':'T00:00:00Z');
      if(Date.parse(availableAt)>now.getTime())continue;
      items.push({sessionDate,closedAt:symbol==='USDINR=X'?availableAt:sessionDate+(symbol==='RELIANCE.NS'?'T10:00:00Z':'T21:00:00Z'),availableAt,
        close:symbol==='AAPL'?'100':symbol==='MSFT'?'200':symbol==='USDINR=X'?'80':sessionDate<'2024-10-28'?'1000':'500',
        dividend:symbol!=='USDINR=X'&&sessionDate.endsWith('-06-03')?(symbol==='RELIANCE.NS'?'2':'1'):'0',split:symbol==='RELIANCE.NS'&&sessionDate==='2024-10-28'?'2':'1'});
    }
    series[symbol]={currency:symbol==='AAPL'||symbol==='MSFT'?'USD':'INR',items};
  }
  return {version:3,source:'yfinance',priceBasis:'contemporaneous',fetchedAt:now.toISOString(),series};
}
