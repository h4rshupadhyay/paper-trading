export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  expectedSchemaVersion: number;
  publicOrigin: string;
  csrfSecret: string;
  trustProxyHops?: 1;
};

function invalid(field: string): never {
  throw new Error(`Invalid or missing configuration: ${field}`);
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') invalid('NODE_ENV');

  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) invalid('PORT');

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) invalid('DATABASE_URL');
  let database: URL;
  try { database = new URL(databaseUrl); } catch { invalid('DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname
    || !database.username || !database.password || database.pathname.length < 2 || database.hash
    || ['user', 'password', 'host', 'port', 'database', 'dbname'].some(key => database.searchParams.has(key))) {
    invalid('DATABASE_URL');
  }

  const publicOrigin = env.PUBLIC_ORIGIN;
  if (!publicOrigin) invalid('PUBLIC_ORIGIN');
  let origin: URL;
  try { origin = new URL(publicOrigin); } catch { invalid('PUBLIC_ORIGIN'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== publicOrigin
    || origin.username || origin.password) invalid('PUBLIC_ORIGIN');

  const csrfSecret = env.CSRF_SECRET;
  if (!csrfSecret || !csrfSecret.trim() || Buffer.byteLength(csrfSecret, 'utf8') < 32) invalid('CSRF_SECRET');

  if (env.TRUST_PROXY_HOPS !== undefined && env.TRUST_PROXY_HOPS !== '1') invalid('TRUST_PROXY_HOPS');
  return { ...(env.TRUST_PROXY_HOPS === '1' ? {trustProxyHops: 1 as const} : {}), nodeEnv, port, databaseUrl, expectedSchemaVersion: 6, publicOrigin, csrfSecret };
}
