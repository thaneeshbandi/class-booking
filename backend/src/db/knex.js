import knexFactory from 'knex';

import './pgTypes.js';
import config from '../../knexfile.js';

/**
 * One shared pool per process. Migrations, seeds, the server and the tests all
 * go through this instance so connection settings can never diverge.
 */
export const db = knexFactory(config);

export async function assertConnection() {
  await db.raw('select 1');
}

export async function closeConnection() {
  await db.destroy();
}
