import path from 'node:path';

import { backendRoot, env } from './src/config/env.js';

/**
 * Managed Postgres free tiers (Supabase, Render) present certificates that are
 * not in Node's trust store. `rejectUnauthorized: false` is therefore required
 * there and deliberately opt-in via DATABASE_SSL, so a local container is never
 * silently downgraded to an unverified TLS session.
 */
export const connection = {
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
};

const config = {
  client: 'pg',
  connection,
  pool: { min: 0, max: 10 },
  migrations: {
    directory: path.join(backendRoot, 'migrations'),
    tableName: 'knex_migrations',
    extension: 'js',
    loadExtensions: ['.js'],
    // Every migration is one DDL transaction: a failure leaves no half-built
    // table behind, which is what makes "migrate from zero" reliably repeatable.
    disableTransactions: false,
  },
  seeds: {
    directory: path.join(backendRoot, 'seeds'),
    loadExtensions: ['.js'],
  },
};

export default config;
