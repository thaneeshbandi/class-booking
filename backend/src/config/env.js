import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

export const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

// Load backend/.env when present. Real environments (Render, CI) set process.env
// directly and have no file; dotenv never overwrites an already-set variable.
dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });

/**
 * `Intl` is the only IANA database Node ships. Constructing a formatter with an
 * unknown zone throws, which makes this the cheapest real validation available.
 *
 * This matters more than it looks: STUDIO_TIMEZONE decides where a studio day
 * starts and ends, so a typo silently shifts every "sessions today" boundary
 * rather than failing. Validating it at startup turns that into a loud error.
 */
function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  // Single connection string, so the same variable works for a local container,
  // Supabase, Render and CI without per-part variables drifting apart.
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (value) => /^postgres(ql)?:\/\//.test(value),
      'DATABASE_URL must start with postgres:// or postgresql://',
    ),

  // Managed free tiers (Supabase, Render) terminate TLS with certificates that
  // are not in Node's trust store, so this is opt-in rather than inferred.
  DATABASE_SSL: booleanish.default('false'),

  // The wall-clock zone the studio operates in. The database stores instants
  // only; every civil-day boundary is computed from this.
  STUDIO_TIMEZONE: z
    .string()
    .min(1, 'STUDIO_TIMEZONE is required')
    .refine(isValidTimeZone, 'STUDIO_TIMEZONE must be a valid IANA time zone'),

  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  // Optional: the least-privileged role the application connects as in a
  // deployed environment. When set, migrations grant it table privileges and
  // revoke UPDATE/DELETE/TRUNCATE on booking_events. Unset (local development,
  // where migrations and the app share one role) the grants are skipped and the
  // append-only trigger is the sole enforcement.
  APP_DB_ROLE: z
    .string()
    .regex(
      /^[A-Za-z_][A-Za-z0-9_$]*$/,
      'APP_DB_ROLE must be a bare PostgreSQL identifier',
    )
    .optional(),

  // Not yet required: authentication is not implemented in this milestone.
  // It becomes mandatory when the auth layer lands.
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .optional(),

  // Consumed only by the seed script, never by the running server.
  SEED_PASSWORD: z.string().min(8).optional(),
});

export class EnvValidationError extends Error {
  constructor(issues) {
    super(
      `Invalid environment configuration:\n${issues
        .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n')}\n\nSee backend/.env.example for the expected variables.`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function parseEnv(source = process.env) {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(result.error.issues);
  }
  return result.data;
}

/**
 * Validated at import time, so every entry point — the server, the migration
 * runner, the seed runner and the tests — fails immediately and identically on
 * a misconfigured environment rather than at the first query.
 */
export const env = parseEnv();

export const isProduction = env.NODE_ENV === 'production';
