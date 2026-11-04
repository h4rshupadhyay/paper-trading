import { expect, it } from 'vitest';
import { readQuoteEvents } from '../src/modules/market-data/stream-worker.js';
import { startMarketStream } from '../src/modules/market-data/stream-worker.js';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createHarness } from './harness.js';
import { migrate } from '../src/platform/migrate.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { ingestStreamQuote } from '../src/modules/market-data/service.js';
import { submitOrder,evaluatePending } from '../src/modules/trading/service.js';
import { createAlert,evaluateAlerts } from '../src/modules/user-tools/service.js';
import { reconcileAccount } from '../src/modules/accounts/reconciliation.js';
import { runWorkerLoop } from '../src/worker.js';
import { createSafeLogger } from '../src/platform/logging.js';
it('decodes chunked SSE, ignores heartbeats and yields only quote frames',async()=>{
  const text=': heartbeat\r\n\r\nevent: quote\r\ndata: {"symbol":"AAPL","quote":{"rawPrice":"123.45"}}\r\n\r\nevent: other\ndata: {}\n\n';
  const body=new ReadableStream<Uint8Array>({start(controller){for(const char of text)controller.enqueue(new TextEncoder().encode(char));controller.close();}});
  const output=[];for await(const item of readQuoteEvents(new Response(body)))output.push(item);
  expect(output).toEqual([{symbol:'AAPL',quote:{rawPrice:'123.45'}}]);
});

it('elects one stream consumer, wakes exact fills and alerts once, and recovers from disconnect',async()=>{
  const h=await createHarness();const streams=new Set<ServerResponse>();let subscriptions:string[]=[];
  const oldTime=new Date(Date.now()-5000).toISOString();
  const upstream=createServer(async(request,response)=>{
    if(request.url==='/subscriptions'){
      let body='';for await(const chunk of request)body+=String(chunk);
      subscriptions=JSON.parse(body).symbols;response.setHeader('Content-Type','application/json');response.end('{"ok":true}');return;
    }
    if(request.url?.startsWith('/quote')||request.url?.startsWith('/fx')){
      const url=new URL(request.url,'http://upstream');response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify(url.pathname==='/quote'?{instrument:{symbol:'AAPL',name:'Apple',exchange:'NMS',currency:'USD',multiplier:'1',kind:'EQUITY'},
        quote:{rawPrice:'200',rawCurrency:'USD',observedAt:oldTime,session:'UNKNOWN',actionKey:'yfinance-raw'}}:
        {currency:url.searchParams.get('currency'),rate:url.searchParams.get('currency')==='USD'?'83':'1',observedAt:oldTime}));return;
    }
    response.setHeader('Content-Type','text/event-stream');response.write(': heartbeat\n\n');streams.add(response);response.once('close',()=>streams.delete(response));
  });
  let first:ReturnType<typeof startMarketStream>|undefined,second:ReturnType<typeof startMarketStream>|undefined,worker:ReturnType<typeof runWorkerLoop>|undefined;
  try{
    await migrate(h.ownerPool);
    const user=(await registerUser(h.appPool,{username:'stream_trader',email:'stream-trader@example.invalid',password:'unused'},async()=> 'test-hash')).user;
    const id=(await h.appPool.query(`INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,provider)
      VALUES('AAPL','Apple','NMS','USD',1,'EQUITY',true,'yfinance') RETURNING id`)).rows[0].id;
    await h.appPool.query("INSERT INTO latest_fx_rates(currency,rate,observed_at,provider) VALUES('USD',83,clock_timestamp(),'yfinance'),('INR',1,clock_timestamp(),'yfinance')");
    await ingestStreamQuote(h.appPool,id,{rawPrice:'200',rawCurrency:'USD',observedAt:new Date(Date.now()-5000).toISOString(),session:'UNKNOWN',actionKey:'yfinance-raw'});
    const order=(await submitOrder(h.appPool,user.id,{instrumentId:id,side:'BUY',type:'LIMIT',quantity:'2',limitPrice:'150'},randomUUID())).order;
    const alert=await createAlert(h.appPool,user.id,{instrumentId:id,condition:'BELOW',targetPrice:'150'});
    worker=runWorkerLoop(h.appPool,{intervalMs:10000,refresh:async()=>{},pending:()=>evaluatePending(h.appPool),alerts:()=>evaluateAlerts(h.appPool),snapshots:async()=>{}});
    await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
    const address=upstream.address();if(!address||typeof address==='string')throw Error('No upstream');
    const options={url:`http://127.0.0.1:${address.port}`,onQuote:()=>worker!.wake(),logger:createSafeLogger(()=>{})};
    first=startMarketStream(h.appPool,options);second=startMarketStream(h.appPool,options);
    await expect.poll(()=>streams.size).toBe(1);expect(subscriptions).toContain('AAPL');
    const message={symbol:'AAPL',quote:{rawPrice:'140.25',rawCurrency:'USD',observedAt:new Date().toISOString(),session:'UNKNOWN',actionKey:'yfinance-raw'}};
    const send=()=>{for(const response of streams)response.write(`event: quote\ndata: ${JSON.stringify(message)}\n\n`);};
    send();send();
    await expect.poll(async()=>(await h.appPool.query('SELECT status FROM orders WHERE id=$1',[order.id])).rows[0].status,{timeout:4000}).toBe('FILLED');
    await expect.poll(async()=>(await h.appPool.query('SELECT active FROM price_alerts WHERE id=$1',[alert.id])).rows[0].active).toBe(false);
    expect((await h.appPool.query('SELECT price::text,settlement::text FROM executions WHERE order_id=$1',[order.id])).rows).toEqual([{price:'140.25000000',settlement:'23281.50'}]);
    expect((await h.appPool.query('SELECT count(*)::int n FROM notifications')).rows[0].n).toBe(1);
    const current=[...streams][0]!;current.end();
    await expect.poll(()=>[...streams].some(response=>response!==current),{timeout:5000}).toBe(true);
    expect(streams.size).toBe(1);send();
    expect((await h.appPool.query('SELECT count(*)::int n FROM executions WHERE order_id=$1',[order.id])).rows[0].n).toBe(1);
    expect((await reconcileAccount(h.appPool,user.id)).balanced).toBe(true);
  }finally{
    await Promise.all([first?.stop(),second?.stop(),worker?.stop()]);
    upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));await h.close();
  }
},15000);
it('rejects oversized, malformed and truncated stream frames',async()=>{
  for(const text of ['data: '+'x'.repeat(65537),'event: quote\ndata: {bad}\n\n','event: quote\ndata: {}']){
    await expect(async()=>{for await(const _ of readQuoteEvents(new Response(text))) { /* consume */ }}).rejects.toThrow();
  }
});
