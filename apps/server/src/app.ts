import { marketRoutes } from './modules/market-data/http.js';
import { toolsRoutes } from './modules/user-tools/http.js';
import { tradingRoutes } from './modules/trading/http.js';
import { portfolioRoutes } from './modules/portfolio/http.js';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { accountRoutes } from './modules/accounts/http.js';
import { identityRoutes } from './modules/identity/http.js';
import { AppError } from './platform/errors.js';
import { authThrottle, enforceOrigin, errorHandler, type HttpDependencies, requestContext, serviceUnavailable } from './platform/http.js';
import { readSchemaVersion } from './platform/migrate.js';

export function createApp(deps: HttpDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.trustProxyHops ?? false);
  app.use(requestContext(deps.logger));
  app.use(helmet());
  app.use(enforceOrigin(deps.config));
  app.post('/api/auth/login', authThrottle());
  app.post('/api/auth/register', authThrottle());
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());
  app.use('/api/auth', identityRoutes(deps));
  app.use('/api/account', accountRoutes(deps));
  app.get('/api/health/live', (_request, response) => { response.json({ status: 'ok' }); });
  app.get('/api/health/ready', async (_request, response) => {
    try {
      if (await readSchemaVersion(deps.pool) !== deps.config.expectedSchemaVersion) throw serviceUnavailable();
    } catch { throw serviceUnavailable(); }
    response.json({ status: 'ok' });
  });
  app.use('/api', tradingRoutes(deps));
  app.use('/api', portfolioRoutes(deps));
  app.use('/api', toolsRoutes(deps));
  app.use('/api', marketRoutes(deps));
  app.use((_request, _response, next) => { next(new AppError(404, 'NOT_FOUND', 'Not found')); });
  app.use(errorHandler(deps.logger));
  return app;
}
