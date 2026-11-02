import { z } from 'zod';
import type { LoginInput, RegisterInput } from '@paper/contracts/foundation';
import { AppError } from '../../platform/errors.js';

const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/);
const emailSchema = z.string().trim().toLowerCase()
  .max(254)
  .regex(/^[\x00-\x7f]+$/)
  .pipe(z.email());
const passwordSchema = z.string().refine((password) => {
  const bytes = new TextEncoder().encode(password).byteLength;
  return bytes >= 12 && bytes <= 72;
});

const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
}).strict();

const loginSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const fields: Record<string, string> = Object.create(null);
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string') fields[field] ??= 'Invalid value';
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) fields[key] ??= 'Unrecognized field';
    }
  }

  throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request', Object.keys(fields).length ? fields : undefined);
}

export function parseRegisterInput(value: unknown): RegisterInput {
  return parse(registerSchema, value);
}

export function parseLoginInput(value: unknown): LoginInput {
  return parse(loginSchema, value);
}
