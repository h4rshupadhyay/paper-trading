import { z } from 'zod';
import { AppError } from '../../platform/errors.js';

export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const singleLine = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const body = z.string().max(10000).refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
const noteFields = { title: singleLine(200), body, instrumentId: uuid.nullable().optional() };
export const folderInput = z.strictObject({ name: singleLine(80) });
export const entryInput = z.strictObject({ instrumentId: uuid, folderId: uuid.optional() });
export const moveInput = z.strictObject({ folderId: uuid });
export const noteInput = z.strictObject(noteFields);
export const notePatch = z.strictObject(noteFields).partial().refine(value => Object.keys(value).length > 0);
export const alertInput = z.strictObject({ instrumentId: uuid, condition: z.enum(['ABOVE', 'BELOW']),
  targetPrice: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/).refine(value => /[1-9]/.test(value)) });
export const readInput = z.strictObject({ ids: z.array(uuid).min(1).max(100).refine(ids => new Set(ids).size === ids.length) });
export const emptyInput = z.strictObject({});
const pageFields = { limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).optional(), cursor: z.string().max(64).optional() };
const pageInput = z.strictObject(pageFields);
const entryPageInput = z.strictObject({ ...pageFields, folderId: uuid.optional() });
const notificationPageInput = z.strictObject({ ...pageFields, unread: z.enum(['true', 'false']).optional() });

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request');
  return parsed.data;
}
export function id(value: unknown): string { return parse(uuid, value).toLowerCase(); }
export type Page = { limit: number; after: string | null; folderId?: string };
export function pagination(query: unknown, entries = false): Page {
  const parsed = entries ? parse(entryPageInput, query) : parse(pageInput, query);
  let after: string | null = null;
  if (parsed.cursor !== undefined) {
    const decoded = Buffer.from(parsed.cursor, 'base64url').toString('utf8');
    if (!uuid.safeParse(decoded).success || Buffer.from(decoded).toString('base64url') !== parsed.cursor) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid cursor');
    }
    after = decoded.toLowerCase();
  }
  const folderId = 'folderId' in parsed && typeof parsed.folderId === 'string' ? parsed.folderId : undefined;
  return { limit: Number(parsed.limit ?? 50), after, ...(folderId ? { folderId } : {}) };
}
export function notificationPagination(query: unknown): Page & { unread: boolean } {
  const parsed = parse(notificationPageInput, query);
  return { ...pagination({ limit: parsed.limit, cursor: parsed.cursor }), unread: parsed.unread === 'true' };
}
export function pageResult<T extends { id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? Buffer.from(items[items.length - 1]!.id).toString('base64url') : null };
}
