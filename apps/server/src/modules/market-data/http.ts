import { marketStreamRoutes } from './stream-http.js';
import { marketSnapshot, initialStatistics } from './snapshot.js';
import { Router } from 'express';
import { AppError } from '../../platform/errors.js';
import { type HttpDependencies, requireSession } from '../../platform/http.js';
import { type HistoryOptions } from './provider.js';
import { discoverInstruments, getProvider, readFxRates, readHistory, readInstrument, readQuote, refreshInstrument } from './service.js';

function queryKeys(query: object, allowed: string[]) {
  if (Object.keys(query).some(k => !allowed.includes(k))) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid market query');
}
export function marketRoutes(deps: HttpDependencies): Router {
  const { pool } = deps;
  const router = Router();
  router.use('/market/stream', marketStreamRoutes(deps));
  router.use(['/instruments','/fx-rates'],async (request, _response, next) => { await requireSession(pool, request); next(); });
  router.get('/instruments', async (request, response) => {
    queryKeys(request.query, ['q']);
    const q = request.query.q ?? '';
    if (typeof q !== 'string' || q.length > 80 || /[\x00-\x1f]/.test(q)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid search query');
    response.json({ items: await discoverInstruments(pool, q.trim()), nextCursor: null });
  });
  router.get('/instruments/:id', async (request, response) => {
    queryKeys(request.query, []); response.json({ instrument: await readInstrument(pool, request.params.id as string) });
  });
  router.get('/instruments/:id/quote', async (request, response) => {
    queryKeys(request.query, []); const id = request.params.id as string;
    await refreshInstrument(pool, id); response.json(await readQuote(pool, id));
  });
  router.get('/instruments/:id/statistics', async (request,response)=>{
    queryKeys(request.query,[]);response.json({statistics:await initialStatistics(pool,request.params.id as string)});
  });
  router.get('/instruments/:id/snapshot', async (request,response)=>{
    queryKeys(request.query,[]); response.json(await marketSnapshot(pool,request.params.id as string));
  });
  router.get('/instruments/:id/history', async (request, response) => {
    queryKeys(request.query, ['period','interval']);
    const { period,interval } = request.query;
    if ((period !== undefined && (typeof period !== 'string' || !['1d','5d','1mo','3mo','6mo','1y','5y'].includes(period)))
      || (interval !== undefined && (typeof interval !== 'string' || !['5m','15m','1d','1wk','1mo'].includes(interval)))) throw new AppError(400,'VALIDATION_ERROR','Invalid chart period or interval');
    const options: HistoryOptions = { ...(period ? { period: period as HistoryOptions['period'] & string } : {}), ...(interval ? { interval: interval as HistoryOptions['interval'] & string } : {}) };
    response.json(await readHistory(pool, request.params.id as string, getProvider(), options));
  });
  router.get('/fx-rates', async (request, response) => { queryKeys(request.query, []); response.json(await readFxRates(pool, getProvider())); });
  return router;
}
