import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { createPool } from '../src/platform/db.js';
import { createSafeLogger } from '../src/platform/logging.js';
import { migrate } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';

let harness: TestHarness;
const origin = 'https://paper.example';
const password = 'correct password 123';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://app:password@127.0.0.1:55439/unused', PUBLIC_ORIGIN: origin, CSRF_SECRET: 'test csrf secret with at least 32 bytes' });
let logs: unknown[];
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  harness = await createHarness();
  await migrate(harness.ownerPool);
  logs = [];
  app = createApp({ pool: harness.appPool, config, logger: createSafeLogger(entry => logs.push(entry)) });
});
afterEach(async () => { vi.restoreAllMocks(); await harness.close(); });
const input = (username = 'alice') => ({ username, email: `${username}@example.com`, password });
const cookie = (response: request.Response): string => {
  const cookies = response.headers['set-cookie'] as unknown as string[];
  expect(cookies).toHaveLength(1);
  return cookies[0]!.split(';')[0]!;
};
async function register(username = 'alice') {
  return request(app).post('/api/auth/register').set('Origin', origin).send(input(username));
}
async function login(username = 'alice', previous?: string) {
  const pending = request(app).post('/api/auth/login').set('Origin', origin).send({ username, password });
  if (previous) pending.set('Cookie', previous);
  return pending;
}
function safeError(response: request.Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ error: { code, message: expect.any(String), requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) } });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['x-request-id']).toBe(response.body.error.requestId);
}

describe('protected HTTP account slice', () => {
  it('registers without logging in, exposes only safe identity/account data, and revokes on CSRF logout', async () => {
    const registered = await register();
    expect(registered.status).toBe(201);
    expect(registered.headers['set-cookie']).toBeUndefined();
    expect(registered.body.user).toEqual({ id: expect.any(String), username: 'alice', email: 'alice@example.com' });
    expect(registered.body.account).toEqual({ id: expect.any(String), baseCurrency: 'INR', cashBalance: '1000000.00', cashSequence: '1' });
    safeError(await request(app).get('/api/account'), 401, 'UNAUTHENTICATED');
    const signedIn = await login();
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toEqual({ user: registered.body.user });
    const sessionCookie = cookie(signedIn);
    expect((signedIn.headers['set-cookie'] as unknown as string[])[0]).toMatch(/Path=\/api;.*HttpOnly; SameSite=Lax/);
    expect((signedIn.headers['set-cookie'] as unknown as string[])[0]).toContain('Max-Age=86400');
    expect((signedIn.headers['set-cookie'] as unknown as string[])[0]).not.toContain('Domain=');
    expect((signedIn.headers['set-cookie'] as unknown as string[])[0]).not.toContain('Secure');
    const me = await request(app).get('/api/auth/me').set('Cookie', sessionCookie);
    expect(me.body).toEqual({ user: registered.body.user });
    const csrf = await request(app).get('/api/auth/csrf').set('Cookie', sessionCookie);
    expect(csrf.body).toEqual({ csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const account = await request(app).get('/api/account').set('Cookie', sessionCookie);
    expect(account.body).toEqual({ account: registered.body.account });
    for (const response of [registered, signedIn, me, csrf, account]) expect(response.headers['cache-control']).toBe('no-store');
    safeError(await request(app).post('/api/auth/logout').set('Origin', origin).set('Cookie', sessionCookie), 403, 'CSRF_INVALID');
    const logout = await request(app).post('/api/auth/logout').set('Origin', origin).set('Cookie', sessionCookie).set('X-CSRF-Token', csrf.body.csrfToken);
    expect(logout.status).toBe(204);
    expect(logout.text).toBe('');
    expect((logout.headers['set-cookie'] as unknown as string[])[0]).toMatch(/paper_session=; Path=\/api; Expires=Thu, 01 Jan 1970/);
    safeError(await request(app).get('/api/account').set('Cookie', sessionCookie), 401, 'UNAUTHENTICATED');
  });

  it('sets the production cookie security policy', async () => {
    app = createApp({ pool: harness.appPool, config: { ...config, nodeEnv: 'production' }, logger: createSafeLogger(() => {}) });
    await register();
    const response = await login();
    const header = (response.headers['set-cookie'] as unknown as string[])[0]!;
    expect(header).toContain('HttpOnly'); expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax'); expect(header).toContain('Path=/api');
    expect(header).toContain('Max-Age=86400'); expect(header).not.toContain('Domain=');
  });

  it('rotates the supplied session, binds CSRF to its session, and checks inactive users on each request', async () => {
    const registered = await register();
    const first = cookie(await login());
    const firstCsrf = (await request(app).get('/api/auth/csrf').set('Cookie', first)).body.csrfToken;
    const second = cookie(await login());
    safeError(await request(app).post('/api/auth/logout').set('Origin', origin).set('Cookie', second).set('X-CSRF-Token', firstCsrf), 403, 'CSRF_INVALID');
    const rotated = cookie(await login('alice', first));
    safeError(await request(app).get('/api/auth/me').set('Cookie', first), 401, 'UNAUTHENTICATED');
    expect((await request(app).get('/api/auth/me').set('Cookie', rotated)).status).toBe(200);
    await harness.ownerPool.query('UPDATE users SET active=false WHERE id=$1', [registered.body.user.id]);
    for (const path of ['/api/auth/me', '/api/auth/csrf', '/api/account']) {
      safeError(await request(app).get(path).set('Cookie', second), 401, 'UNAUTHENTICATED');
    }
    safeError(await login(), 401, 'INVALID_CREDENTIALS');
  });

  it('isolates owned accounts and rejects every account query override', async () => {
    const first = await register(); const firstCookie = cookie(await login());
    const second = await register('bobby'); const secondCookie = cookie(await login('bobby'));
    expect(second.body.account.id).not.toBe(first.body.account.id);
    expect((await request(app).get('/api/account').set('Cookie', firstCookie)).body.account.id).toBe(first.body.account.id);
    expect((await request(app).get('/api/account').set('Cookie', secondCookie)).body.account.id).toBe(second.body.account.id);
    for (const query of [`?userId=${second.body.user.id}`, `?accountId=${second.body.account.id}`, '?unused=', '?__proto__[userId]=x']) {
      safeError(await request(app).get(`/api/account${query}`).set('Cookie', firstCookie), 400, 'VALIDATION_ERROR');
    }
  });

  it('requires an exact non-null Origin for every unsafe route before handling input', async () => {
    for (const path of ['/api/auth/register', '/api/auth/login', '/api/auth/logout']) {
      for (const value of [undefined, 'null', 'https://evil.example', `${origin}/`, `${origin}.evil.example`]) {
        const pending = request(app).post(path).send(input());
        if (value) pending.set('Origin', value);
        const response = await pending;
        safeError(response, 403, 'ORIGIN_FORBIDDEN');
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
    }
  });

  it('normalizes malformed, oversized and invalid JSON and rejects duplicate identities', async () => {
    safeError(await request(app).post('/api/auth/login').set('Origin', origin).set('Content-Type', 'application/json').send('{'), 400, 'INVALID_JSON');
    safeError(await request(app).post('/api/auth/register').set('Origin', origin).send({ ...input(), password: 'x'.repeat(17000) }), 413, 'BODY_TOO_LARGE');
    const invalid = await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'alice' });
    expect(invalid.status).toBe(400); expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    expect(invalid.body.error.fields).toEqual({ password: 'Invalid value' });
    await register(); safeError(await register(), 409, 'IDENTITY_CONFLICT');
    safeError(await request(app).post('/api/auth/login').set('Origin', origin), 400, 'VALIDATION_ERROR');
    safeError(await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'missing', password }), 401, 'INVALID_CREDENTIALS');
    safeError(await request(app).get('/api/unknown').set('X-Request-ID', 'untrusted-id'), 404, 'NOT_FOUND');
  });

  it('limits login and registration independently at 20 attempts per IP and ignores forged proxy headers', async () => {
    expect(app.get('trust proxy')).toBe(false);
    for (let i = 0; i < 20; i++) {
      expect((await request(app).post('/api/auth/login').set('Origin', origin).set('X-Forwarded-For', `192.0.2.${i}`).send({})).status).toBe(400);
    }
    const limited = await request(app).post('/api/auth/login').set('Origin', origin).set('X-Forwarded-For', '198.51.100.1').send({});
    safeError(limited, 429, 'RATE_LIMITED'); expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) expect((await request(app).post('/api/auth/register').set('Origin', origin).send({})).status).toBe(400);
    safeError(await request(app).post('/api/auth/register').set('Origin', origin).send({}), 429, 'RATE_LIMITED');
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 15 * 60 * 1000 + 1);
    expect((await request(app).post('/api/auth/login').set('Origin', origin).send({})).status).toBe(400);
    expect((await request(app).post('/api/auth/register').set('Origin', origin).send({})).status).toBe(400);
  });

  it('keeps liveness independent of storage and exposes safe readiness schema failures without migrating', async () => {
    expect((await request(app).get('/api/health/live')).body).toEqual({ status: 'ok' });
    expect((await request(app).get('/api/health/ready')).body).toEqual({ status: 'ok' });
    await harness.ownerPool.query('UPDATE schema_migrations SET version=5 WHERE version=4');
    safeError(await request(app).get('/api/health/ready'), 503, 'SERVICE_UNAVAILABLE');
    expect((await harness.ownerPool.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 5 }]);
    await harness.ownerPool.query('DROP TABLE schema_migrations');
    safeError(await request(app).get('/api/health/ready'), 503, 'SERVICE_UNAVAILABLE');
    expect((await request(app).get('/api/health/live')).status).toBe(200);
  });

  it('maps connection refusal and missing schema to 503 rather than authentication errors', async () => {
    const registered = await register(); const sessionCookie = cookie(await login());
    await harness.ownerPool.query('DROP TABLE sessions');
    safeError(await request(app).get('/api/account').set('Cookie', sessionCookie), 503, 'SERVICE_UNAVAILABLE');
    const unavailable = createPool('postgresql://app:never-log-this@127.0.0.1:1/unused');
    try {
      app = createApp({ pool: unavailable, config, logger: createSafeLogger(entry => logs.push(entry)) });
      safeError(await request(app).get('/api/auth/me').set('Cookie', `paper_session=${randomBytes(32).toString('base64url')}`), 503, 'SERVICE_UNAVAILABLE');
      safeError(await login(), 503, 'SERVICE_UNAVAILABLE');
      safeError(await request(app).get('/api/health/ready'), 503, 'SERVICE_UNAVAILABLE');
      expect((await request(app).get('/api/health/live')).status).toBe(200);
      expect(JSON.stringify(logs)).not.toContain('never-log-this');
      expect(registered.status).toBe(201);
    } finally { await unavailable.end(); }
  });

  it('never logs credentials, cookies, CSRF, headers, query strings, or unexpected SQL errors', async () => {
    await register(); const signedIn = await login(); const sessionCookie = cookie(signedIn);
    const csrf = (await request(app).get('/api/auth/csrf').set('Cookie', sessionCookie)).body.csrfToken;
    await request(app).get('/api/nope?password=query-secret').set('Authorization', 'Bearer header-secret').set('X-Request-ID', 'attacker-id');
    await harness.ownerPool.query(`CREATE FUNCTION http_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sql-secret'; END; $$; CREATE TRIGGER http_fault AFTER INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION http_fault()`);
    const failed = await login(); safeError(failed, 500, 'INTERNAL_ERROR'); expect(failed.text).not.toContain('sql-secret');
    const captured = JSON.stringify(logs);
    for (const secret of [password, sessionCookie.split('=')[1]!, csrf, 'header-secret', 'query-secret', 'attacker-id', 'sql-secret', config.csrfSecret, 'alice@example.com']) expect(captured).not.toContain(secret);
    expect(logs.length).toBeGreaterThan(0);
    const filtered: unknown[] = [];
    const logger = createSafeLogger(entry => filtered.push(entry));
    logger.error('request_error', { requestId: 'safe', password, headers: { cookie: sessionCookie }, body: input(), error: new Error('sql-secret'), status: 500 });
    expect(filtered).toEqual([{ level: 'error', event: 'request_error', requestId: 'safe', status: 500 }]);
  });

  it('rejects expired and forged sessions and requires authentication for CSRF/logout', async () => {
    await register(); const sessionCookie = cookie(await login());
    await harness.ownerPool.query("UPDATE sessions SET expires_at=CURRENT_TIMESTAMP-interval '1 second'");
    for (const value of [sessionCookie, 'paper_session=bad', `paper_session=${randomBytes(32).toString('base64url')}`]) {
      safeError(await request(app).get('/api/account').set('Cookie', value), 401, 'UNAUTHENTICATED');
    }
    safeError(await request(app).get('/api/auth/csrf'), 401, 'UNAUTHENTICATED');
    safeError(await request(app).post('/api/auth/logout').set('Origin', origin).set('X-CSRF-Token', 'invalid'), 401, 'UNAUTHENTICATED');
  });

  it('validates runtime configuration before listen, serves the API, and shuts down on SIGTERM', async () => {
    const invalid = spawn(process.execPath, ['--import', 'tsx', 'src/api.ts'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', PUBLIC_ORIGIN: origin, CSRF_SECRET: config.csrfSecret }, stdio: ['ignore', 'pipe', 'pipe'] });
    let invalidOutput = ''; invalid.stdout.on('data', chunk => { invalidOutput += chunk; }); invalid.stderr.on('data', chunk => { invalidOutput += chunk; });
    const invalidCode = await new Promise(resolve => invalid.once('exit', resolve));
    expect(invalidCode).toBe(1); expect(invalidOutput).toContain('API startup failed');
    const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address(); if (!address || typeof address === 'string') throw new Error('Missing test port');
    const port = address.port; await new Promise<void>(resolve => listener.close(() => resolve()));
    const options = harness.appPool.options;
    const url = new URL(config.databaseUrl); url.username = String(options.user); url.password = String(options.password); url.pathname = `/${options.database}`;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/api.ts'], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: url.href, PUBLIC_ORIGIN: origin, CSRF_SECRET: config.csrfSecret }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
      await vi.waitFor(() => expect(output).toContain('api_listening'), { timeout: 5000 });
      expect((await request(`http://127.0.0.1:${port}`).get('/api/health/ready')).status).toBe(200);
      child.kill('SIGTERM');
      expect(await exited).toBe(0); expect(output).toContain('api_stopped');
      expect(output).not.toContain(String(options.password)); expect(output).not.toContain(config.csrfSecret);
    } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } }
  });
});
