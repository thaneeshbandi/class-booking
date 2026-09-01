import { env } from '../config/env.js';

/**
 * Least-privilege role wiring for migrations.
 *
 * The approved schema locks `booking_events` down with `REVOKE UPDATE, DELETE,
 * TRUNCATE` from the application role. That revoke is only meaningful if the
 * application connects as a role that is *not* the table owner — an owner keeps
 * its privileges no matter what is revoked, and a superuser bypasses privilege
 * checks entirely. So migrations must run as the owner and the app must connect
 * as APP_DB_ROLE.
 *
 * When APP_DB_ROLE is unset (local development, where one role does everything)
 * the grants are skipped and the append-only trigger is the sole enforcement.
 * The trigger applies to every role, so history immutability never depends on
 * this being configured.
 */

export async function roleExists(knex, role) {
  const { rows } = await knex.raw('select 1 from pg_roles where rolname = ?', [
    role,
  ]);
  return rows.length > 0;
}

async function appRole(knex) {
  const role = env.APP_DB_ROLE;
  if (!role) return null;
  if (!(await roleExists(knex, role))) {
    // A configured-but-absent role is a deployment mistake, not a reason to
    // abandon the migration: the schema is still correct without the grants.
    console.warn(
      `[migrations] APP_DB_ROLE="${role}" does not exist; skipping grants.`,
    );
    return null;
  }
  return role;
}

/** Base privileges the application needs on an ordinary domain table. */
export async function grantAppTablePrivileges(knex, table) {
  const role = await appRole(knex);
  if (!role) return false;
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON ?? TO ??', [
    table,
    role,
  ]);
  return true;
}

/**
 * `booking_events` is append-only: the application may read and insert, nothing
 * more. Identity columns need no separate sequence grant — the sequence backing
 * `GENERATED ALWAYS AS IDENTITY` is reached through the table's INSERT
 * privilege, unlike a `serial` column's sequence.
 */
export async function grantAppendOnlyPrivileges(knex, table) {
  const role = await appRole(knex);
  if (!role) return false;
  await knex.raw('REVOKE ALL ON ?? FROM ??', [table, role]);
  await knex.raw('GRANT SELECT, INSERT ON ?? TO ??', [table, role]);
  return true;
}
