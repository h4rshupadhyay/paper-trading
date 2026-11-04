import type { Pool, PoolClient, Notification } from 'pg';
import type { ProviderQuote } from './provider.js';
import { ingestStreamQuote,refreshInstrument,streamUnitsDue } from './service.js';
import { YfinanceProvider } from './yfinance-provider.js';
import { createSafeLogger, type SafeLogger } from '../../platform/logging.js';

type Tick={symbol:string;quote:ProviderQuote};
/** Incremental SSE parser with a hard bound even when the producer omits delimiters. */
export async function* readQuoteEvents(response:Response):AsyncGenerator<Tick>{
  if(!response.body)throw Error('Missing quote stream');
  const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
  try{
    for(;;){
      const {done,value}=await reader.read();
      pending+=decoder.decode(value,{stream:!done});
      if(pending.length>65536)throw Error('Quote frame too large');
      let match:RegExpExecArray|null;
      while((match=/\r?\n\r?\n/.exec(pending))){
        const frame=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);
        let event='message';const data:string[]=[];
        for(const line of frame.split(/\r?\n/)){
          if(line.startsWith('event:'))event=line.slice(6).trim();
          if(line.startsWith('data:'))data.push(line.slice(5).trimStart());
        }
        if(event==='quote'){
          const tick:unknown=JSON.parse(data.join('\n'));
          if(!tick||typeof tick!=='object'||!('symbol' in tick)||typeof tick.symbol!=='string'
            ||!('quote'in tick)||!tick.quote||typeof tick.quote!=='object'||Array.isArray(tick.quote))throw Error('Invalid stream envelope');
          yield tick as Tick;
        }
      }
      if(done){if(pending.trim())throw Error('Truncated quote frame');return;}
    }
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

function wait(ms:number,signal:AbortSignal):Promise<void>{
  return new Promise(resolve=>{
    if(signal.aborted){resolve();return;}
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});
  });
}
const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
type Options={url?:string;request?:typeof fetch;onQuote?:()=>void;logger?:SafeLogger};

/** One elected consumer for all worker processes. The sidecar owns the Yahoo socket. */
export function startMarketStream(pool:Pool,options:Options={}):{done:Promise<void>;stop():Promise<void>}{
  const base=new URL(options.url??process.env.YFINANCE_URL??'http://127.0.0.1:8000');
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('Invalid YFINANCE_URL');
  const request=options.request??fetch,logger=options.logger??createSafeLogger();
  const stopping=new AbortController(),interests=new Map<string,number>();
  async function run(){
    let failures=0;
    while(!stopping.signal.aborted){
      let client:PoolClient|undefined,locked=false,discard=false;
      const disconnected=new AbortController(),signal=AbortSignal.any([stopping.signal,disconnected.signal]);
      const lost=()=>{discard=true;disconnected.abort();};
      let dirty=true;
      const interested=(message:Notification)=>{
        if(message.channel!=='paper_market_interest'||!message.payload||message.payload.length>5000)return;
        try{
          const data:unknown=JSON.parse(message.payload);
          if(!data||typeof data!=='object'||!('ids'in data)||!Array.isArray(data.ids)||data.ids.length>100)return;
          for(const id of data.ids)if(typeof id==='string'&&uuid.test(id))interests.set(id,Date.now()+90000);
          for(const [id,expiry]of interests)if(expiry<Date.now())interests.delete(id);
          while(interests.size>1000)interests.delete(interests.keys().next().value!);
          dirty=true;
        }catch{/* Ignore malformed internal notifications. */}
      };
      try{
        client=await pool.connect();client.on('error',lost);client.on('end',lost);
        locked=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(1480963207) AS locked')).rows[0]!.locked;
        if(!locked){await wait(2000,signal);continue;}
        await client.query('LISTEN paper_market_interest');client.on('notification',interested);
        let instruments=new Map<string,string>(),nextRenewal=0;
        const unitAttempts=new Map<string,number>();
        const provider=new YfinanceProvider(base.href,(input,init)=>request(input,{...init,
          signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])}));
        const renew=async()=>{
          for(const [id,expiry]of interests)if(expiry<Date.now())interests.delete(id);
          const rows=(await pool.query<{id:string;symbol:string}>(`WITH demand AS (
            SELECT instrument_id AS id,0 AS priority FROM orders WHERE status IN ('OPEN','TRIGGERED')
            UNION ALL SELECT instrument_id,1 FROM positions WHERE quantity>0
            UNION ALL SELECT instrument_id,2 FROM price_alerts WHERE active
            UNION ALL SELECT instrument_id,3 FROM watchlist_entries
            UNION ALL SELECT id,4 FROM instruments WHERE id=ANY($1::uuid[]))
            SELECT i.id,i.symbol FROM demand d JOIN instruments i ON i.id=d.id WHERE i.provider='yfinance'
            GROUP BY i.id,i.symbol ORDER BY min(d.priority),i.id LIMIT 100`,[[...interests.keys()]])).rows;
          const next=new Map(rows.map(item=>[item.symbol,item.id]));
          const response=await request(new URL('/subscriptions',base),{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({symbols:[...next.keys()]}),signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
          await response.body?.cancel();if(!response.ok)throw Error('Subscription refused');
          instruments=next;nextRenewal=Date.now()+15000;
          for(const id of unitAttempts.keys())if(![...next.values()].includes(id))unitAttempts.delete(id);
        };
        await renew();dirty=false;
        const management=(async()=>{
          while(!signal.aborted){await wait(250,signal);if(signal.aborted)return;
            if(dirty||Date.now()>=nextRenewal){dirty=false;await renew();}
            const units=[...instruments.values()].filter(id=>streamUnitsDue(pool,id)&&Date.now()-(unitAttempts.get(id)??0)>=30000).slice(0,2);
            for(const id of units)unitAttempts.set(id,Date.now());
            await Promise.all(units.map(id=>refreshInstrument(pool,id,provider)));
          }
        })().catch(()=>{disconnected.abort();});
        let idle:ReturnType<typeof setTimeout>|undefined;
        try{
          idle=setTimeout(()=>disconnected.abort(),10000);
          const response=await request(new URL('/stream',base),{headers:{Accept:'text/event-stream'},signal});
          if(!response.ok||!response.headers.get('content-type')?.includes('text/event-stream')){await response.body?.cancel();throw Error('Quote stream refused');}
          clearTimeout(idle);idle=setTimeout(()=>disconnected.abort(),45000);
          // An idle transport is broken even when no stocks trade; heartbeats renew it.
          const body=response.body!;
          const upstream=body.getReader();
          const monitored=new ReadableStream<Uint8Array>({
            async pull(controller){
              try{const item=await upstream.read();if(item.done){upstream.releaseLock();controller.close();return;}
                clearTimeout(idle);idle=setTimeout(()=>disconnected.abort(),45000);controller.enqueue(item.value);
              }catch(error){controller.error(error);}
            },async cancel(){disconnected.abort();await upstream.cancel().catch(()=>{});try{upstream.releaseLock();}catch{/* Already released on EOF. */}},
          });
          for await(const tick of readQuoteEvents(new Response(monitored))){
            if(signal.aborted)break;
            const id=instruments.get(tick.symbol);
            if(id&&await ingestStreamQuote(pool,id,tick.quote)){failures=0;options.onQuote?.();}
          }
          if(!signal.aborted)throw Error('Quote stream ended');
        }finally{clearTimeout(idle);disconnected.abort();await management;}
      }catch{
        if(!stopping.signal.aborted)logger.error('market_stream_disconnected',{code:'SERVICE_UNAVAILABLE'});
      }finally{
        disconnected.abort();
        if(client){
          client.removeListener('notification',interested);
          if(locked&&!discard)try{await client.query('UNLISTEN paper_market_interest');await client.query('SELECT pg_advisory_unlock(1480963207)');}catch{discard=true;}
          client.removeListener('error',lost);client.removeListener('end',lost);client.release(discard);
        }
      }
      if(!stopping.signal.aborted){failures=Math.min(failures+1,6);await wait(Math.min(30000,1000*2**(failures-1))*(.75+Math.random()*.5),stopping.signal);}
    }
  }
  const done=run();return {done,async stop(){stopping.abort();await done;}};
}
