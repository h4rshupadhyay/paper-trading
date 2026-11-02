import { Router } from 'express';
import { AppError } from '../../platform/errors.js';
import { type HttpDependencies, requireSession, requireMutation } from '../../platform/http.js';
import { cancelOrder, submitOrder, orderProjection, type OrderView } from './service.js';
import { requireId } from './input.js';
export function pagination(query:Record<string,unknown>,extraKeys:string[]=[]):{limit:number;cursor:string|null}{
  if(Object.keys(query).some(k=>!['limit','cursor',...extraKeys].includes(k)))throw new AppError(400,'VALIDATION_ERROR','Invalid query');
  const raw=query.limit??'50';if(typeof raw!=='string'||!/^(?:[1-9]\d?|100)$/.test(raw))throw new AppError(400,'VALIDATION_ERROR','Invalid page size');
  return {limit:Number(raw),cursor:query.cursor===undefined?null:requireId(query.cursor)};
}
export function tradingRoutes({pool,config}:HttpDependencies):Router{
  const router=Router();
  router.post('/orders',async(req,res)=>{const {principal}=await requireMutation(pool,req,config);const result=await submitOrder(pool,principal.user.id,req.body,req.get('Idempotency-Key'));res.status(result.replayed?200:201).json({order:result.order});});
  router.get('/orders',async(req,res)=>{const {principal}=await requireSession(pool,req);const {limit,cursor}=pagination(req.query,['status']);
    const status=req.query.status??null;
    if(status!==null&&(typeof status!=='string'||!['OPEN','TRIGGERED','FILLED','CANCELLED','REJECTED','EXPIRED'].includes(status)))throw new AppError(400,'VALIDATION_ERROR','Invalid order status');
    if(cursor&&!(await pool.query('SELECT 1 FROM orders o JOIN accounts a ON a.id=o.account_id WHERE o.id=$1 AND a.user_id=$2',[cursor,principal.user.id])).rowCount)throw new AppError(400,'VALIDATION_ERROR','Invalid cursor');
    const items=(await pool.query<OrderView>(`SELECT ${orderProjection} FROM orders o JOIN accounts a ON a.id=o.account_id JOIN instruments i ON i.id=o.instrument_id WHERE a.user_id=$1 AND ($4::text IS NULL OR o.status=$4) AND ($2::uuid IS NULL OR (o.created_at,o.id)<(SELECT created_at,id FROM orders WHERE id=$2)) ORDER BY o.created_at DESC,o.id DESC LIMIT $3`,[principal.user.id,cursor,limit+1,status])).rows;
    res.json({items:items.slice(0,limit),nextCursor:items.length>limit?items[limit-1]!.id:null});
  });
  router.get('/orders/:id',async(req,res)=>{const {principal}=await requireSession(pool,req);const id=requireId(req.params.id);
    const order=(await pool.query<OrderView>(`SELECT ${orderProjection} FROM orders o JOIN accounts a ON a.id=o.account_id JOIN instruments i ON i.id=o.instrument_id WHERE a.user_id=$1 AND o.id=$2`,[principal.user.id,id])).rows[0];
    if(!order)throw new AppError(404,'ORDER_NOT_FOUND','Order not found');res.json({order});
  });
  router.post('/orders/:id/cancel',async(req,res)=>{const {principal}=await requireMutation(pool,req,config);if(req.body&&Object.keys(req.body).length)throw new AppError(400,'VALIDATION_ERROR','Invalid request');res.json({order:await cancelOrder(pool,principal.user.id,requireId(req.params.id))});});
  router.get('/executions',async(req,res)=>{const {principal}=await requireSession(pool,req);const {limit,cursor}=pagination(req.query);
    if(cursor&&!(await pool.query('SELECT 1 FROM executions e JOIN accounts a ON a.id=e.account_id WHERE e.id=$1 AND a.user_id=$2',[cursor,principal.user.id])).rowCount)throw new AppError(400,'VALIDATION_ERROR','Invalid cursor');
    const items=(await pool.query<{id:string}>(`SELECT e.id,e.order_id AS "orderId",e.instrument_id AS "instrumentId",i.symbol,e.side,e.quantity::text,e.price::text,e.currency,
      e.native_amount::text AS "nativeAmount",e.fx_rate::text AS "fxRate",e.settlement::text,e.allocated_native_cost::text AS "allocatedNativeCost",
      e.allocated_base_cost::text AS "allocatedBaseCost",e.realized_pl::text AS "realizedPl",e.quote_observed_at AS "quoteObservedAt",e.fx_observed_at AS "fxObservedAt",e.created_at AS "createdAt"
      FROM executions e JOIN accounts a ON a.id=e.account_id JOIN instruments i ON i.id=e.instrument_id WHERE a.user_id=$1
       AND ($2::uuid IS NULL OR (e.created_at,e.id)<(SELECT created_at,id FROM executions WHERE id=$2)) ORDER BY e.created_at DESC,e.id DESC LIMIT $3`,[principal.user.id,cursor,limit+1])).rows;
    res.json({items:items.slice(0,limit),nextCursor:items.length>limit?items[limit-1]!.id:null});
  });return router;
}
