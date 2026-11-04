import { getProvider } from './modules/market-data/service.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './platform/config.js';
import { createPool } from './platform/db.js';
import { createSafeLogger } from './platform/logging.js';
import { closeMarketStreams } from './modules/market-data/stream-http.js';

export async function startApi(): Promise<void> {
  const config = loadConfig(process.env);
  getProvider();
  const logger = createSafeLogger();
  const pool = createPool(config.databaseUrl);
  pool.on('error', () => { logger.error('database_unavailable', { code: 'SERVICE_UNAVAILABLE' }); });
  const server = createApp({ pool, config, logger }).listen(config.port);
  try {
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  } catch (error) { await pool.end(); throw error; }
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  logger.info('api_listening', { port: config.port });
  let stopping = false;
  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.info('api_stopping', { signal });
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      logger.error('api_shutdown_timeout', {});
      process.exit(1);
    }, 10000);
    try {
      await closeMarketStreams(pool);
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await pool.end();
      logger.info('api_stopped', {});
    } finally {
      clearTimeout(deadline);
      process.off('SIGTERM', onTerminate);
      process.off('SIGINT', onInterrupt);
    }
  }
  function stop(signal: string): void {
    void shutdown(signal).catch(() => { logger.error('api_shutdown_failed', {}); process.exitCode = 1; });
  }
  function onTerminate(): void { stop('SIGTERM'); }
  function onInterrupt(): void { stop('SIGINT'); }
  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onInterrupt);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await startApi(); }
  catch { console.error('API startup failed'); process.exitCode = 1; }
}
