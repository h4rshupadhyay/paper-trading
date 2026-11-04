import { Router } from 'express';
import { type HttpDependencies, requireSession } from '../../platform/http.js';
import { AppError } from '../../platform/errors.js';
import { pagination } from '../trading/http.js';
import { readPortfolioHistory } from './history.js';
import { readPortfolio } from './service.js';
export function portfolioRoutes({pool}:HttpDependencies):Router{
  const router=Router();
  router.get('/portfolio',async(req,res)=>{const {principal}=await requireSession(pool,req);if(Object.keys(req.query).length)throw new AppError(400,'VALIDATION_ERROR','Invalid query');res.json(await readPortfolio(pool,principal.user.id));});
  router.get('/portfolio/history',async(req,res)=>{const {principal}=await requireSession(pool,req);res.json(await readPortfolioHistory(pool,principal.user.id,req.query));});
  router.get('/portfolio/snapshots',async(req,res)=>{const {principal}=await requireSession(pool,req);const {limit,cursor}=pagination(req.query,['days']);
    const rawDays=req.query.days;
    if(rawDays!==undefined&&(typeof rawDays!=='string'||!/^\d{1,4}$/.test(rawDays)||Number(rawDays)<1||Number(rawDays)>1825))throw new AppError(400,'VALIDATION_ERROR','Invalid snapshot range');
    const days=rawDays===undefined?null:Number(rawDays);
    if(cursor&&!(await pool.query('SELECT 1 FROM portfolio_snapshots s JOIN accounts a ON a.id=s.account_id WHERE s.id=$1 AND a.user_id=$2',[cursor,principal.user.id])).rowCount)throw new AppError(400,'VALIDATION_ERROR','Invalid cursor');
    const items=(await pool.query<{id:string}>(`SELECT s.id,s.account_sequence::text AS "accountSequence",s.sampled_at AS "sampledAt",s.cash_balance::text AS "cashBalance",s.holdings_value::text AS "holdingsValue",s.total_value::text AS "totalValue",s.unrealized_pl::text AS "unrealizedPl",s.quality,s.observed_from AS "observedFrom",s.observed_to AS "observedTo" FROM portfolio_snapshots s JOIN accounts a ON a.id=s.account_id WHERE a.user_id=$1 AND ($4::integer IS NULL OR s.sampled_at>=clock_timestamp()-make_interval(days=>$4::integer)) AND ($2::uuid IS NULL OR (s.sampled_at,s.id)<(SELECT sampled_at,id FROM portfolio_snapshots WHERE id=$2)) ORDER BY s.sampled_at DESC,s.id DESC LIMIT $3`,[principal.user.id,cursor,limit+1,days])).rows;
    res.json({items:items.slice(0,limit),nextCursor:items.length>limit?items[limit-1]!.id:null});
  });return router;
}
