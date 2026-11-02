import { randomUUID } from 'node:crypto';
import type { Principal } from '@paper/contracts/foundation';
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { verifyCsrf, authenticate } from '../modules/identity/sessions.js';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import type { SafeLogger } from './logging.js';

export type HttpDependencies = { pool: Pool; config: Config; logger: SafeLogger };

export function sessionToken(request: Request): string | undefined {
  const value: unknown = request.cookies?.paper_session;
  return typeof value === 'string' ? value : undefined;
}

export async function requireSession(pool: Pool, request: Request): Promise<{ principal: Principal; token: string }> {
  const token = sessionToken(request);
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  return { principal: await authenticate(pool, token), token };
}


export async function requireMutation(pool: Pool, request: Request, config: Config): Promise<{ principal: Principal; token: string }> {
  const session = await requireSession(pool, request);
  if (!verifyCsrf(session.token, request.get('X-CSRF-Token') ?? '', config.csrfSecret)) {
    throw new AppError(403, 'CSRF_INVALID', 'Invalid CSRF token');
  }
  return session;
}

export function requestContext(logger: SafeLogger): RequestHandler {
  return (request, response, next) => {
    const requestId = randomUUID();
    response.locals.requestId = requestId;
    response.set({ 'X-Request-ID': requestId, 'Cache-Control': 'no-store' });
    const started = performance.now();
    response.once('finish', () => {
      logger.info('request_completed', {
        requestId, method: request.method, route: request.route?.path ?? 'unmatched',
        status: response.statusCode, durationMs: Math.round(performance.now() - started),
      });
    });
    next();
  };
}

export function enforceOrigin(config: Config): RequestHandler {
  return (request, _response, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.get('Origin') !== config.publicOrigin) {
      next(new AppError(403, 'ORIGIN_FORBIDDEN', 'Origin forbidden'));
      return;
    }
    next();
  };
}

export function authThrottle(): RequestHandler {
  const windows = new Map<string, { count: number; expires: number }>();
  const interval = 15 * 60 * 1000;
  return (request, response, next) => {
    const now = Date.now();
    for (const [ip, window] of windows) if (window.expires <= now) windows.delete(ip);
    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const window = windows.get(ip) ?? { count: 0, expires: now + interval };
    windows.set(ip, window);
    if (window.count >= 20) {
      response.set('Retry-After', String(Math.max(1, Math.ceil((window.expires - now) / 1000))));
      next(new AppError(429, 'RATE_LIMITED', 'Too many attempts'));
      return;
    }
    window.count++;
    next();
  };
}

function unavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? error.code : undefined;
  return typeof code === 'string' && (/^(08|53)/.test(code)
    || ['57P01', '57P02', '57P03', '42P01', '42703', '42883', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', '57014'].includes(code))
    || ['Query read timeout', 'Connection terminated unexpectedly', 'Connection terminated due to connection timeout', 'timeout exceeded when trying to connect'].includes(error.message);
}

export function serviceUnavailable(): AppError {
  return new AppError(503, 'SERVICE_UNAVAILABLE', 'Service unavailable');
}

export function errorHandler(logger: SafeLogger): ErrorRequestHandler {
  return (error: unknown, _request, response: Response, _next) => {
    let safe: AppError;
    if (error instanceof AppError) safe = error;
    else if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
      safe = new AppError(413, 'BODY_TOO_LARGE', 'Request body too large');
    } else if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.parse.failed') {
      safe = new AppError(400, 'INVALID_JSON', 'Invalid JSON');
    } else if (typeof error === 'object' && error !== null && 'type' in error
      && ['charset.unsupported', 'encoding.unsupported'].includes(String(error.type))) {
      safe = new AppError(415, 'UNSUPPORTED_ENCODING', 'Unsupported request encoding');
    } else if (unavailable(error)) safe = serviceUnavailable();
    else safe = new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
    const requestId: string = response.locals.requestId;
    if (safe.status >= 500) logger.error('request_error', { requestId, status: safe.status, code: safe.code });
    response.status(safe.status).json({ error: {
      code: safe.code, message: safe.message, ...(safe.fields ? { fields: safe.fields } : {}), requestId,
    } });
  };
}
