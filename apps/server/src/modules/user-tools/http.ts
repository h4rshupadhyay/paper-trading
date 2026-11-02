import { Router } from 'express';
import { type HttpDependencies, requireMutation, requireSession } from '../../platform/http.js';
import { alertInput, emptyInput, entryInput, folderInput, id, moveInput, noteInput, notePatch, notificationPagination, pagination, parse, readInput } from './input.js';
import * as tools from './service.js';

export function toolsRoutes({ pool, config }: HttpDependencies): Router {
  const router = Router();
  // Only owned tools paths participate: this router shares the /api mount with
  // market/trading, so it must not authenticate unrelated public endpoints.
  router.use(['/watchlists', '/notes', '/alerts', '/notifications'], async (request, response, next) => {
    const { principal } = request.method === 'GET' ? await requireSession(pool, request) : await requireMutation(pool, request, config);
    response.locals.toolsUserId = principal.user.id; next();
  });
  router.get('/watchlists', async (request, response) => {
    parse(emptyInput, request.query);
    const userId: string = response.locals.toolsUserId;
    const [folders, entries] = await Promise.all([tools.folders(pool, userId, { after: null, limit: 100 }), tools.entries(pool, userId, { after: null, limit: 1000 })]);
    response.json({ folders: folders.items, items: entries.items });
  });
  router.get('/watchlists/folders', async (request, response) => response.json(await tools.folders(pool, response.locals.toolsUserId, pagination(request.query))));
  router.post('/watchlists/folders', async (request, response) => {
    parse(emptyInput, request.query); const input = parse(folderInput, request.body);
    response.status(201).json({ folder: await tools.createFolder(pool, response.locals.toolsUserId, input.name) });
  });
  router.patch('/watchlists/folders/:id', async (request, response) => {
    parse(emptyInput, request.query); const folderId = id(request.params.id); const input = parse(folderInput, request.body);
    response.json({ folder: await tools.renameFolder(pool, response.locals.toolsUserId, folderId, input.name) });
  });
  router.delete('/watchlists/folders/:id', async (request, response) => {
    parse(emptyInput, request.query); await tools.deleteFolder(pool, response.locals.toolsUserId, id(request.params.id)); response.status(204).end();
  });
  router.get('/watchlists/entries', async (request, response) => response.json(await tools.entries(pool, response.locals.toolsUserId, pagination(request.query, true))));
  router.post('/watchlists/entries', async (request, response) => {
    parse(emptyInput, request.query); response.status(201).json({ entry: await tools.createEntry(pool, response.locals.toolsUserId, parse(entryInput, request.body)) });
  });
  router.patch('/watchlists/entries/:id', async (request, response) => {
    parse(emptyInput, request.query); const entryId = id(request.params.id); const input = parse(moveInput, request.body);
    response.json({ entry: await tools.moveEntry(pool, response.locals.toolsUserId, entryId, input.folderId) });
  });
  router.delete('/watchlists/entries/:id', async (request, response) => {
    parse(emptyInput, request.query); await tools.deleteEntry(pool, response.locals.toolsUserId, id(request.params.id)); response.status(204).end();
  });
  router.get('/notes', async (request, response) => response.json(await tools.notes(pool, response.locals.toolsUserId, pagination(request.query))));
  router.get('/notes/:id', async (request, response) => {
    parse(emptyInput, request.query); response.json({ note: await tools.readNote(pool, response.locals.toolsUserId, id(request.params.id)) });
  });
  router.post('/notes', async (request, response) => {
    parse(emptyInput, request.query); response.status(201).json({ note: await tools.createNote(pool, response.locals.toolsUserId, parse(noteInput, request.body)) });
  });
  router.patch('/notes/:id', async (request, response) => {
    parse(emptyInput, request.query); const noteId = id(request.params.id); response.json({ note: await tools.updateNote(pool, response.locals.toolsUserId, noteId, parse(notePatch, request.body)) });
  });
  router.delete('/notes/:id', async (request, response) => {
    parse(emptyInput, request.query); await tools.deleteNote(pool, response.locals.toolsUserId, id(request.params.id)); response.status(204).end();
  });
  router.get('/alerts', async (request, response) => response.json(await tools.alerts(pool, response.locals.toolsUserId, pagination(request.query))));
  router.post('/alerts', async (request, response) => {
    parse(emptyInput, request.query); response.status(201).json({ alert: await tools.createAlert(pool, response.locals.toolsUserId, parse(alertInput, request.body)) });
  });
  router.delete('/alerts/:id', async (request, response) => {
    parse(emptyInput, request.query); await tools.deleteAlert(pool, response.locals.toolsUserId, id(request.params.id)); response.status(204).end();
  });
  router.get('/notifications', async (request, response) => response.json(await tools.notifications(pool, response.locals.toolsUserId, notificationPagination(request.query))));
  router.post('/notifications/read', async (request, response) => {
    parse(emptyInput, request.query); response.json(await tools.markRead(pool, response.locals.toolsUserId, parse(readInput, request.body).ids));
  });
  return router;
}
