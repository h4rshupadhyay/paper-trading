import { Router, type CookieOptions } from 'express';
import { AppError } from '../../platform/errors.js';
import { type HttpDependencies, requireSession, sessionToken } from '../../platform/http.js';
import { parseLoginInput, parseRegisterInput } from './input.js';
import { hashPassword } from './passwords.js';
import { registerUser } from './registration.js';
import { csrfForSession, login, revokeSession, verifyCsrf } from './sessions.js';

export function identityRoutes({ pool, config }: HttpDependencies): Router {
  const router = Router();
  const cookieOptions: CookieOptions = { path: '/api', httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production' };
  router.post('/register', async (request, response) => {
    response.status(201).json(await registerUser(pool, parseRegisterInput(request.body), hashPassword));
  });
  router.post('/login', async (request, response) => {
    const result = await login(pool, parseLoginInput(request.body), config.csrfSecret, sessionToken(request));
    response.cookie('paper_session', result.session.token, { ...cookieOptions, maxAge: 86400 * 1000 });
    response.json({ user: result.user });
  });
  router.get('/me', async (request, response) => {
    const { principal } = await requireSession(pool, request);
    response.json({ user: principal.user });
  });
  router.get('/csrf', async (request, response) => {
    const { token } = await requireSession(pool, request);
    response.json({ csrfToken: csrfForSession(token, config.csrfSecret) });
  });
  router.post('/logout', async (request, response) => {
    const { principal, token } = await requireSession(pool, request);
    if (!verifyCsrf(token, request.get('X-CSRF-Token') ?? '', config.csrfSecret)) {
      throw new AppError(403, 'CSRF_INVALID', 'Invalid CSRF token');
    }
    await revokeSession(pool, principal.sessionId);
    response.clearCookie('paper_session', cookieOptions).status(204).end();
  });
  return router;
}
