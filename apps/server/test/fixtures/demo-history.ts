// Provider-shaped deterministic observations. Literal prices make independent
// accounting assertions possible; this fixture never supplies production data.
import type {DemoHistory} from '../../src/modules/demo/history.js';
export function demoHistory():DemoHistory {
  const dates: string[]=[];
  const start=new Date();start.setUTCDate(start.getUTCDate()-30);start.setUTCHours(0,0,0,0);
  for(let n=0;n<30;n++){
    const d=new Date(start.getTime()+n*86400000);
    if(d.getUTCDay()!==0&&d.getUTCDay()!==6)dates.push(d.toISOString().slice(0,10));
  }
  const series=Object.fromEntries([
    ['AAPL','USD','200','21:00:00','05:00:00'],['MSFT','USD','400','21:00:00','05:00:00'],
    ['RELIANCE.NS','INR','1500','10:00:00','00:00:00'],['USDINR=X','INR','90','00:00:00','00:00:00'],
  ].map(([symbol,currency,close,time,availability])=>[symbol,{currency,items:dates.map(sessionDate=>{
    const next=new Date(`${sessionDate}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+1);
    const availableAt=`${next.toISOString().slice(0,10)}T${availability}Z`;
    return {sessionDate,close,closedAt:symbol==='USDINR=X'?availableAt:`${sessionDate}T${time}Z`,availableAt};
  })}]));
  return {source:'yfinance',fetchedAt:new Date().toISOString(),corporateActions:'none',series:series as DemoHistory['series']};
}
