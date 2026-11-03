import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { withTransaction } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { pageResult, type Page } from './input.js';

type Row = QueryResultRow & { id: string };
type Db = Pool | PoolClient;
const folderFields = 'id,name,is_default AS "isDefault"';
const noteFields = 'n.id,n.instrument_id AS "instrumentId",i.symbol,n.title,n.body,n.created_at AS "createdAt",n.updated_at AS "updatedAt"';
const noteFrom = 'notes n LEFT JOIN instruments i ON i.id=n.instrument_id';
const alertFields = `a.id,a.instrument_id AS "instrumentId",i.symbol,i.currency,a.condition,a.target_price AS "targetPrice",
  a.active,a.created_at AS "createdAt",a.triggered_at AS "triggeredAt"`;
const entryFields = `e.id,e.folder_id AS "folderId",e.instrument_id AS "instrumentId",i.symbol,i.name,i.currency,q.price,
  CASE WHEN q.price IS NULL OR i.paused THEN 'UNAVAILABLE'
    WHEN q.observed_at<now()-interval '60 seconds' OR q.observed_at>now()+interval '5 seconds' THEN 'STALE'
    WHEN q.session='REGULAR' THEN 'FRESH' WHEN q.session='CLOSED' THEN 'CLOSED' ELSE 'UNAVAILABLE' END AS quality`;
const entryFrom = 'watchlist_entries e JOIN instruments i ON i.id=e.instrument_id LEFT JOIN latest_quotes q ON q.instrument_id=i.id';
const missing = () => new AppError(404, 'NOT_FOUND', 'Resource not found');
function found<T>(row: T | undefined): T { if (row === undefined) throw missing(); return row; }

async function mutate<T>(pool: Pool, userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(pool, async client => {
      // Same-owner mutations serialize before touching folders or entries, including a
      // previously absent destination entry. Transactions on other owners stay independent.
      found((await client.query('SELECT * FROM public.lock_active_user($1)', [userId])).rows[0]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,731))', [userId]);
      return work(client);
    });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === '23505') throw new AppError(409, 'RESOURCE_CONFLICT', 'Resource already exists');
    if (code === '23503') throw missing();
    throw error;
  }
}
async function ownedFolder(db: Db, userId: string, folderId?: string): Promise<Row & { isDefault: boolean }> {
  return found((await db.query<Row & { isDefault: boolean }>(`SELECT ${folderFields} FROM watchlist_folders
    WHERE user_id=$1 AND ${folderId ? 'id=$2' : 'is_default'}`, folderId ? [userId, folderId] : [userId])).rows[0]);
}
async function instrument(db: Db, instrumentId: string): Promise<void> {
  found((await db.query('SELECT id FROM instruments WHERE id=$1', [instrumentId])).rows[0]);
}
export async function folders(pool: Pool, userId: string, page: Page) {
  return pageResult((await pool.query<Row>(`SELECT ${folderFields} FROM watchlist_folders
    WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`, [userId, page.after, page.limit + 1])).rows, page.limit);
}
export async function createFolder(pool: Pool, userId: string, name: string) {
  return mutate(pool, userId, async client => {
    const count = (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM watchlist_folders WHERE user_id=$1', [userId])).rows[0]!.count;
    if (count >= 100) throw new AppError(409, 'RESOURCE_LIMIT', 'A watchlist supports at most 100 folders');
    return (await client.query<Row>(`INSERT INTO watchlist_folders(user_id,name) VALUES($1,$2) RETURNING ${folderFields}`, [userId, name])).rows[0]!;
  });
}
export async function renameFolder(pool: Pool, userId: string, folderId: string, name: string) {
  return mutate(pool, userId, async client => found((await client.query<Row>(`UPDATE watchlist_folders SET name=$3
    WHERE user_id=$1 AND id=$2 RETURNING ${folderFields}`, [userId, folderId, name])).rows[0]));
}
export async function deleteFolder(pool: Pool, userId: string, folderId: string): Promise<void> {
  await mutate(pool, userId, async client => {
    const folder = await ownedFolder(client, userId, folderId);
    if (folder.isDefault) throw new AppError(409, 'DEFAULT_FOLDER', 'Default folder cannot be deleted');
    const target = await ownedFolder(client, userId);
    await client.query(`DELETE FROM watchlist_entries e WHERE e.user_id=$1 AND e.folder_id=$2
      AND EXISTS(SELECT 1 FROM watchlist_entries d WHERE d.user_id=$1 AND d.folder_id=$3 AND d.instrument_id=e.instrument_id)`, [userId, folderId, target.id]);
    await client.query('UPDATE watchlist_entries SET folder_id=$3 WHERE user_id=$1 AND folder_id=$2', [userId, folderId, target.id]);
    await client.query('DELETE FROM watchlist_folders WHERE user_id=$1 AND id=$2', [userId, folderId]);
  });
}
export async function entries(pool: Pool, userId: string, page: Page) {
  if (page.folderId) await ownedFolder(pool, userId, page.folderId);
  return pageResult((await pool.query<Row>(`SELECT ${entryFields} FROM ${entryFrom} WHERE e.user_id=$1
    AND ($2::uuid IS NULL OR e.id>$2) AND ($4::uuid IS NULL OR e.folder_id=$4) ORDER BY e.id LIMIT $3`,
  [userId, page.after, page.limit + 1, page.folderId ?? null])).rows, page.limit);
}
async function readEntry(db: Db, userId: string, entryId: string) {
  return found((await db.query<Row>(`SELECT ${entryFields} FROM ${entryFrom} WHERE e.user_id=$1 AND e.id=$2`, [userId, entryId])).rows[0]);
}
export async function createEntry(pool: Pool, userId: string, input: { instrumentId: string; folderId?: string | undefined }) {
  return mutate(pool, userId, async client => {
    const folder = await ownedFolder(client, userId, input.folderId); await instrument(client, input.instrumentId);
    const count = (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM watchlist_entries WHERE user_id=$1', [userId])).rows[0]!.count;
    if (count >= 1000) throw new AppError(409, 'RESOURCE_LIMIT', 'A watchlist supports at most 1000 entries');
    const row = (await client.query<Row>('INSERT INTO watchlist_entries(user_id,folder_id,instrument_id) VALUES($1,$2,$3) RETURNING id', [userId, folder.id, input.instrumentId])).rows[0]!;
    return readEntry(client, userId, row.id);
  });
}
export async function moveEntry(pool: Pool, userId: string, entryId: string, folderId: string) {
  return mutate(pool, userId, async client => {
    await readEntry(client, userId, entryId); await ownedFolder(client, userId, folderId);
    await client.query('UPDATE watchlist_entries SET folder_id=$3 WHERE user_id=$1 AND id=$2', [userId, entryId, folderId]);
    return readEntry(client, userId, entryId);
  });
}
export async function deleteEntry(pool: Pool, userId: string, entryId: string): Promise<void> {
  await mutate(pool, userId, async client => { found((await client.query('DELETE FROM watchlist_entries WHERE user_id=$1 AND id=$2 RETURNING id', [userId, entryId])).rows[0]); });
}
export async function notes(pool: Pool, userId: string, page: Page) {
  return pageResult((await pool.query<Row>(`SELECT ${noteFields} FROM ${noteFrom} WHERE n.user_id=$1
    AND ($2::uuid IS NULL OR n.id>$2) ORDER BY n.id LIMIT $3`, [userId, page.after, page.limit + 1])).rows, page.limit);
}
export async function readNote(pool: Db, userId: string, noteId: string) {
  return found((await pool.query<Row>(`SELECT ${noteFields} FROM ${noteFrom} WHERE n.user_id=$1 AND n.id=$2`, [userId, noteId])).rows[0]);
}
type NoteInput = { title: string; body: string; instrumentId?: string | null | undefined };
export async function createNote(pool: Pool, userId: string, input: NoteInput) {
  return mutate(pool, userId, async client => {
    if (input.instrumentId) await instrument(client, input.instrumentId);
    const row = (await client.query<Row>(`INSERT INTO notes(user_id,title,body,instrument_id) VALUES($1,$2,$3,$4)
      RETURNING id`, [userId, input.title, input.body, input.instrumentId ?? null])).rows[0]!;
    return readNote(client, userId, row.id);
  });
}
export async function updateNote(pool: Pool, userId: string, noteId: string, input: { title?: string | undefined; body?: string | undefined; instrumentId?: string | null | undefined }) {
  return mutate(pool, userId, async client => {
    await readNote(client, userId, noteId); if (input.instrumentId) await instrument(client, input.instrumentId);
    await client.query(`UPDATE notes SET title=coalesce($3,title),body=coalesce($4,body),
      instrument_id=CASE WHEN $5 THEN $6::uuid ELSE instrument_id END,updated_at=clock_timestamp()
      WHERE user_id=$1 AND id=$2`,
    [userId, noteId, input.title ?? null, input.body ?? null, 'instrumentId' in input, input.instrumentId ?? null]);
    return readNote(client, userId, noteId);
  });
}
export async function deleteNote(pool: Pool, userId: string, noteId: string): Promise<void> {
  await mutate(pool, userId, async client => { found((await client.query('DELETE FROM notes WHERE user_id=$1 AND id=$2 RETURNING id', [userId, noteId])).rows[0]); });
}
export async function alerts(pool: Pool, userId: string, page: Page) {
  return pageResult((await pool.query<Row>(`SELECT ${alertFields} FROM price_alerts a JOIN instruments i ON i.id=a.instrument_id
    WHERE a.user_id=$1 AND ($2::uuid IS NULL OR a.id>$2) ORDER BY a.id LIMIT $3`, [userId, page.after, page.limit + 1])).rows, page.limit);
}
export async function createAlert(pool: Pool, userId: string, input: { instrumentId: string; condition: 'ABOVE' | 'BELOW'; targetPrice: string }) {
  return mutate(pool, userId, async client => {
    await instrument(client, input.instrumentId);
    const row = (await client.query<Row>('INSERT INTO price_alerts(user_id,instrument_id,condition,target_price) VALUES($1,$2,$3,$4) RETURNING id', [userId, input.instrumentId, input.condition, input.targetPrice])).rows[0]!;
    return (await client.query<Row>(`SELECT ${alertFields} FROM price_alerts a JOIN instruments i ON i.id=a.instrument_id WHERE a.user_id=$1 AND a.id=$2`, [userId, row.id])).rows[0]!;
  });
}
export async function deleteAlert(pool: Pool, userId: string, alertId: string): Promise<void> {
  await mutate(pool, userId, async client => { found((await client.query('DELETE FROM price_alerts WHERE user_id=$1 AND id=$2 RETURNING id', [userId, alertId])).rows[0]); });
}
export async function notifications(pool: Pool, userId: string, page: Page & { unread?: boolean }) {
  return pageResult((await pool.query<Row>(`SELECT id,message,read_at AS "readAt",created_at AS "createdAt"
    FROM notifications WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) AND (NOT $4::boolean OR read_at IS NULL)
    ORDER BY id LIMIT $3`, [userId, page.after, page.limit + 1, page.unread ?? false])).rows, page.limit);
}
export async function markRead(pool: Pool, userId: string, ids: string[]) {
  return mutate(pool, userId, async client => {
    const owned = (await client.query('SELECT id FROM notifications WHERE user_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE', [userId, ids])).rows;
    if (owned.length !== ids.length) throw missing();
    const rows = (await client.query<Row>(`UPDATE notifications SET read_at=coalesce(read_at,clock_timestamp())
      WHERE user_id=$1 AND id=ANY($2::uuid[]) RETURNING id,message,read_at AS "readAt",created_at AS "createdAt"`, [userId, ids])).rows;
    return { items: rows };
  });
}

export async function evaluateAlerts(pool: Pool): Promise<void> {
  // One statement atomically locks/claims each active alert and inserts its durable
  // notification. SKIP LOCKED permits competing workers without duplicate claims.
  await pool.query(`WITH candidates AS MATERIALIZED (
    SELECT a.id,q.observed_at,i.symbol,i.currency FROM price_alerts a
    JOIN users u ON u.id=a.user_id AND u.active JOIN instruments i ON i.id=a.instrument_id
    JOIN latest_quotes q ON q.instrument_id=i.id
    WHERE a.active AND NOT i.paused AND q.price>0
      AND ((i.provider='yfinance' AND q.fetched_at>=statement_timestamp()-interval '60 seconds')
        OR (i.provider<>'yfinance' AND q.session='REGULAR' AND q.observed_at>=statement_timestamp()-interval '60 seconds'))
      AND q.observed_at<=statement_timestamp()+interval '5 seconds'
      AND q.fetched_at<=statement_timestamp()+interval '5 seconds'
      AND q.provider=i.provider
      AND ((a.condition='ABOVE' AND q.price>=a.target_price) OR (a.condition='BELOW' AND q.price<=a.target_price))
    ORDER BY a.id LIMIT 100 FOR UPDATE OF a SKIP LOCKED
  ), claimed AS (
    UPDATE price_alerts a SET active=false,triggered_at=statement_timestamp(),triggered_observed_at=c.observed_at
    FROM candidates c WHERE a.id=c.id AND a.active
    RETURNING a.id,a.user_id,a.target_price,c.symbol,c.currency
  ) INSERT INTO notifications(user_id,alert_id,message)
    SELECT user_id,id,symbol||' reached '||target_price::text||' '||currency FROM claimed`);
}
