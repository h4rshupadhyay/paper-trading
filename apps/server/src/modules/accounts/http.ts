import { reconcileAccount } from './reconciliation.js';
import { Router } from 'express';
import { AppError } from '../../platform/errors.js';
import { type HttpDependencies, requireSession } from '../../platform/http.js';
import { readAccount } from './service.js';

export function accountRoutes({ pool }: HttpDependencies): Router {
  const router = Router();
  router.get('/', async (request, response) => {
    const { principal } = await requireSession(pool, request);
    if (Object.keys(request.query).length) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request');
    response.json({ account: await readAccount(pool, principal.user.id) });
  });
  router.get('/reconciliation', async (request,response) => {
    const {principal}=await requireSession(pool,request);
    if(Object.keys(request.query).length)throw new AppError(400,'VALIDATION_ERROR','Invalid query');
    response.json(await reconcileAccount(pool,principal.user.id));
  });
  return router;
}
