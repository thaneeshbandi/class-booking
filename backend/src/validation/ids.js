import { z } from 'zod';

/**
 * A route param naming a `bigint GENERATED ALWAYS AS IDENTITY` id. Validated
 * as a bare positive-integer string rather than coerced to a JS number, for
 * the same reason `auth/tokens.js` keeps `sub` a string: a bigint can exceed
 * `Number.MAX_SAFE_INTEGER`, and Knex/pg accept the string form directly in a
 * `where` clause.
 */
export const idParamSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/, 'Invalid id.');
