import { Router, type Response } from 'express';
import type { Notification, Pool, PoolClient } from 'pg';
import { AppError } from '../../platform/errors.js';
import { requireSession, type HttpDependencies } from '../../platform/http.js';
import { getProvider, markStreamReceipt, readQuote } from './service.js';

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const hubs = new WeakMap<Pool, QuoteHub>();
let connections = 0;
const userConnections = new Map<string, number>();
type Consumer = { ids: Set<string>; response: Response; ready:boolean; close(end?:boolean): void };

/** One process-local listener per pool; only subscribed instrument IDs can enter its bounded work set. */
class QuoteHub {
  readonly consumers = new Set<Consumer>();
  private client: PoolClient | undefined;
  private opening?: Promise<void>;
  private pending = new Set<string>();
  private reading = false;
  private stopped = false;
  constructor(private pool: Pool) {}
  async ready(): Promise<void> {
    this.opening ??= this.connect();
    await this.opening;
    if (this.stopped) throw new Error('Market stream closed');
  }
  private async connect(): Promise<void> {
    const client = await this.pool.connect();
    if (this.stopped) { client.release(true); return; }
    this.client = client;
    client.on('notification', this.notification);
    client.on('error', this.failure);
    client.on('end', this.failure);
    try { await client.query('LISTEN paper_market_quotes'); await client.query('LISTEN paper_market_activity'); }
    catch (error) { await this.stop(); throw error; }
  }
  private failure = (): void => { void this.stop(); };
  private notification = (message: Notification): void => {
    if (this.stopped) return;
    if (message.channel === 'paper_market_activity') {
      for (const consumer of this.consumers) this.send(consumer, 'activity', {});
      return;
    }
    if (message.channel !== 'paper_market_quotes' || !message.payload || message.payload.length > 1024) return;
    let event: { instrumentId?: unknown; transport?: unknown };
    try { event = JSON.parse(message.payload) as typeof event; } catch { return; }
    if (!event || typeof event.instrumentId !== 'string' || !uuid.test(event.instrumentId)
      || !['stream','http'].includes(String(event.transport))) return;
    if (![...this.consumers].some(consumer => consumer.ids.has(event.instrumentId as string))) return;
    if (event.transport === 'stream') markStreamReceipt(this.pool, event.instrumentId);
    this.enqueue(event.instrumentId);
  };
  enqueue(id: string): void {
    if (this.stopped) return;
    this.pending.add(id);
    if (!this.reading) void this.drain();
  }
  private async drain(): Promise<void> {
    this.reading = true;
    try {
      while (!this.stopped && this.pending.size) {
        const id = this.pending.values().next().value!; this.pending.delete(id);
        if (![...this.consumers].some(consumer => consumer.ids.has(id))) continue;
        const instrument = (await this.pool.query<{ symbol: string; provider: string }>('SELECT symbol,provider FROM public.instruments WHERE id=$1',[id])).rows[0];
        if (!instrument || instrument.provider !== getProvider().name) continue;
        const dto = { instrumentId: id, symbol: instrument.symbol, ...await readQuote(this.pool,id) };
        for (const consumer of this.consumers) if (consumer.ids.has(id)) this.send(consumer,'quote',dto);
      }
    } catch { await this.stop(); }
    finally { this.reading = false; }
  }
  send(consumer: Consumer, event: string, data: unknown): void {
    if(!consumer.ready)return;
    if (consumer.response.destroyed || !consumer.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) consumer.close();
  }
  remove(consumer: Consumer): void {
    this.consumers.delete(consumer);
    if (!this.consumers.size) void this.stop();
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (hubs.get(this.pool) === this) hubs.delete(this.pool);
    this.pending.clear();
    for (const consumer of [...this.consumers]) consumer.close();
    const client = this.client; this.client = undefined;
    if (client) {
      client.removeListener('notification',this.notification);
      client.removeListener('error',this.failure);
      client.removeListener('end',this.failure);
      // Destroying prevents LISTEN state leaking to a future borrower, including on database errors.
      client.release(true);
    }
  }
}

export async function closeMarketStreams(pool: Pool): Promise<void> { await hubs.get(pool)?.stop(); }

export function marketStreamRoutes({ pool, config }: HttpDependencies): Router {
  const router = Router();
  router.get('/', async (request,response) => {
    const { principal } = await requireSession(pool,request);
    if (request.get('Origin') && request.get('Origin') !== config.publicOrigin) throw new AppError(403,'ORIGIN_FORBIDDEN','Origin forbidden');
    if (Object.keys(request.query).some(key => key !== 'ids') || (request.query.ids !== undefined && typeof request.query.ids !== 'string')) throw new AppError(400,'VALIDATION_ERROR','Invalid stream query');
    const values = typeof request.query.ids === 'string' && request.query.ids ? request.query.ids.split(',') : [];
    const ids = new Set(values.map(id=>id.toLowerCase()));
    if (ids.size > 100 || values.length > 1000 || [...ids].some(id=>!uuid.test(id))) throw new AppError(400,'VALIDATION_ERROR','Invalid stream identifiers');
    if (ids.size) {
      const known = await pool.query('SELECT id FROM public.instruments WHERE id=ANY($1::uuid[]) AND provider=$2',[[...ids],getProvider().name]);
      if (known.rowCount !== ids.size) throw new AppError(400,'VALIDATION_ERROR','Unknown stream instrument');
    }
    const userId = principal.user.id;
    if (connections >= 50 || (userConnections.get(userId) ?? 0) >= 2) throw new AppError(429,'RATE_LIMITED','Too many market streams');
    connections++; userConnections.set(userId,(userConnections.get(userId) ?? 0)+1);
    let hub = hubs.get(pool); if (!hub) { hub = new QuoteHub(pool); hubs.set(pool,hub); }
    let timer: ReturnType<typeof setInterval> | undefined; let closed = false; let checking = false;
    const consumer: Consumer = { ids, response, ready:false, close(end=true) {
      if (closed) return; closed = true;
      clearInterval(timer); request.removeListener('aborted',consumer.close); response.removeListener('close',consumer.close);
      connections--; const remaining = (userConnections.get(userId) ?? 1)-1;
      if (remaining) userConnections.set(userId,remaining); else userConnections.delete(userId);
      hub!.remove(consumer); if(end)response.end();
    } };
    hub.consumers.add(consumer);
    request.once('aborted',consumer.close); response.once('close',consumer.close);
    const interest = async () => { if (ids.size) await pool.query("SELECT pg_notify('paper_market_interest',$1)",[JSON.stringify({ids:[...ids]})]); };
    try {
      await hub.ready(); if (closed) return;
      await interest(); if (closed) return;
      response.set({'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
      response.flushHeaders();
      consumer.ready=true;
      if (!response.write(': connected\n\n')) { consumer.close(); return; }
      for (const id of ids) hub.enqueue(id);
      timer = setInterval(() => {
        if (checking || closed) return; checking = true;
        void (async () => {
          try {
            await requireSession(pool,request);
            if (closed) return;
            await interest();
            if (!closed && !response.write(': heartbeat\n\n')) consumer.close();
          } catch { consumer.close(); }
          finally { checking = false; }
        })();
      },10000);
      timer.unref();
    } catch (error) { const sent=response.headersSent;consumer.close(sent);if(!sent)throw error; }
  });
  return router;
}
