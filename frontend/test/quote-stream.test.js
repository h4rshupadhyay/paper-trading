import test from 'node:test'
import assert from 'node:assert/strict'
import { createQuoteStream, mergeQuote, mergeWatchlistQuotes, coalesceRefresh } from '../src/services/quoteStream.js'
function harness(){
 let now=Date.parse('2026-11-04T10:00:00Z'), next=0;const jobs=new Map(),sources=[],listeners=new Map()
 const env={now:()=>now,setTimeout:(fn,ms)=>{jobs.set(++next,{fn,at:now+ms});return next},clearTimeout:id=>jobs.delete(id),visible:()=>env.shown,shown:true,listen:(name,fn)=>{listeners.set(name,fn);return()=>listeners.delete(name)},connect:url=>{const source={url,handlers:{},closed:false,addEventListener(name,fn){this.handlers[name]=fn},close(){this.closed=true}};sources.push(source);return source}}
 const advance=ms=>{now+=ms;for(const [id,job]of [...jobs])if(job.at<=now){jobs.delete(id);job.fn()}}
 return {env,sources,advance,listeners,jobs}
}
const packet=(observedAt='2026-11-04T10:00:00Z',price='101')=>({instrumentId:'a',symbol:'A',quality:'fresh',quote:{price,currency:'USD',observedAt,fetchedAt:observedAt,provider:'yfinance'}})
test('mounted consumers share a bounded, debounced union and release resources',()=>{
 const h=harness(),stream=createQuoteStream(h.env)
 const stop=stream.subscribe(['a','b'],()=>{}),stop2=stream.subscribe(['b','c'],()=>{})
 assert.equal(h.sources.length,0);h.advance(100)
 assert.equal(h.sources.length,1);assert.match(h.sources[0].url,/ids=a%2Cb%2Cc/)
 const many=stream.subscribe(Array.from({length:150},(_,i)=>`x${i}`),()=>{});h.advance(100)
 assert.equal(new URL(h.sources.at(-1).url,'http://local').searchParams.get('ids').split(',').length,100)
 stop();stop2();many();assert.equal(h.sources.at(-1).closed,true);assert.equal(h.jobs.size,0);assert.equal(h.listeners.size,0)
})
test('ignores replayed ticks, expires without renewing timestamps and recovers visibility/errors',()=>{
 const h=harness(),stream=createQuoteStream(h.env),seen=[];const stop=stream.subscribe(['a'],event=>seen.push(event))
 h.advance(100);let source=h.sources[0]
 source.handlers.quote({data:JSON.stringify(packet())});source.handlers.quote({data:JSON.stringify(packet())})
 assert.equal(seen.filter(x=>x.type==='quote').length,1)
 h.advance(60001);assert.equal(seen.at(-1).packet.quality,'stale');assert.equal(seen.at(-1).packet.quote.fetchedAt,packet().quote.fetchedAt)
 source.onerror();assert.equal(source.closed,true);h.advance(1000);assert.equal(h.sources.length,2)
 h.env.shown=false;h.listeners.get('visibilitychange')();assert.equal(h.sources[1].closed,true)
 h.env.shown=true;h.listeners.get('visibilitychange')();h.advance(100);assert.equal(h.sources.length,3)
 stop();assert.equal(h.jobs.size,0)
})
test('older SSE and late HTTP cannot regress quote prices, list membership or edits',()=>{
 const newer={id:'a',ticker:'A',name:'Preserved',price:110,observedAt:'2026-11-04T11:00:00Z',fetchedAt:'2026-11-04T11:00:00Z',quality:'fresh'}
 assert.equal(mergeQuote(newer,packet()).price,110)
 const updated=mergeQuote(newer,packet('2026-11-04T12:00:00Z','120'))
 assert.equal(updated.price,120);assert.equal(updated.name,'Preserved')
 const rows=mergeWatchlistQuotes([{...newer,folder_id:'edited',watchlist_id:'w'}],new Map([['a',packet('2026-11-04T12:00:00Z','120')],['other',packet()]]))
 assert.equal(rows.length,1);assert.equal(rows[0].folder_id,'edited');assert.equal(rows[0].price,120)
 assert.equal(mergeQuote(updated,{...newer,price:90}).price,120)
})
test('coalesced refresh is at most once per second, never overlaps, and cancels queued work',async()=>{
 const h=harness();let calls=0,release;const refresh=coalesceRefresh(()=>{calls++;return new Promise(resolve=>{release=resolve})},h.env)
 refresh();refresh();h.advance(1000);assert.equal(calls,1)
 refresh();h.advance(1000);assert.equal(calls,1);release();await Promise.resolve();await Promise.resolve()
 h.advance(1000);assert.equal(calls,2);refresh.cancel();release();await Promise.resolve();h.advance(1000);assert.equal(calls,2)
})
test('subscription churn evicts unused quotes and logout closes all timers until authentication',()=>{
 const h=harness(),stream=createQuoteStream(h.env),seen=[]
 const stopA=stream.subscribe(['a'],event=>seen.push(event)),stopB=stream.subscribe(['b'],()=>{})
 h.advance(100);h.sources[0].handlers.quote({data:JSON.stringify(packet())})
 stopA();h.advance(100)
 const before=seen.length;const stopAgain=stream.subscribe(['a'],event=>seen.push(event))
 assert.equal(seen.length,before,'unused cached subscriptions must be evicted')
 h.advance(100);h.listeners.get('paper:unauthenticated')()
 assert.equal(h.sources.at(-1).closed,true);assert.equal(h.jobs.size,0)
 h.env.shown=false;h.listeners.get('visibilitychange')();h.env.shown=true;h.listeners.get('visibilitychange')();h.advance(60000)
 assert.equal(h.sources.length,3)
 h.listeners.get('paper:authenticated')();h.advance(100);assert.equal(h.sources.length,4)
 stopB();stopAgain()
})
test('an identical HTTP snapshot cannot make an expired displayed quote fresh',()=>{
 const current={...packet().quote,price:101,quality:'stale'}
 assert.equal(mergeQuote(current,{...packet().quote,quality:'fresh'}).quality,'stale')
})
test('malformed packets are ignored and old receipts expire from provider time rather than browser arrival',()=>{
 const h=harness(),stream=createQuoteStream(h.env),seen=[];const stop=stream.subscribe(['a'],event=>seen.push(event));h.advance(100)
 for(const data of ['null','[]','{}','{bad'])assert.doesNotThrow(()=>h.sources[0].handlers.quote({data}))
 const old=packet();old.quote.fetchedAt='2026-11-04T09:58:00Z';old.quote.observedAt=old.quote.fetchedAt
 h.sources[0].handlers.quote({data:JSON.stringify(old)})
 assert.equal(seen.at(-1).packet.quality,'stale');assert.equal(seen.at(-1).live,false)
 stop()
})
test('a pause is applied at the same source time and quote merging preserves its input object',()=>{
 const h=harness(),stream=createQuoteStream(h.env),seen=[];const stop=stream.subscribe(['a'],event=>seen.push(event));h.advance(100)
 h.sources[0].handlers.quote({data:JSON.stringify(packet())})
 h.sources[0].handlers.quote({data:JSON.stringify({...packet(),quality:'unavailable',unavailableReason:'CORPORATE_ACTION_REVIEW'})})
 assert.equal(seen.at(-1).packet.quality,'unavailable')
 const incoming=Object.freeze({...packet().quote,quality:'fresh'})
 assert.equal(mergeQuote({...packet().quote,quality:'stale'},incoming).quality,'stale')
 assert.equal(incoming.quality,'fresh');stop()
})
test('a genuinely newer HTTP receipt can confirm an unchanged source quote, but replay cannot',()=>{
 const h=harness(),stream=createQuoteStream(h.env),seen=[];const stop=stream.subscribe(['a'],event=>seen.push(event));h.advance(100)
 h.sources[0].handlers.quote({data:JSON.stringify(packet())});h.advance(30000)
 const confirmation=packet();confirmation.quote.fetchedAt=new Date(h.env.now()).toISOString()
 h.sources[0].handlers.quote({data:JSON.stringify(confirmation)})
 assert.equal(seen.filter(event=>event.type==='quote').length,2)
 h.advance(30000);assert.equal(seen.at(-1).packet.quality,'fresh')
 h.sources[0].handlers.quote({data:JSON.stringify(confirmation)});h.advance(30001)
 assert.equal(seen.at(-1).packet.quality,'stale');stop()
})
