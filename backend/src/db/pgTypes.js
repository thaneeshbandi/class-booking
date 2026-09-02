import pg from 'pg';

/**
 * node-postgres's default parser for `date` (OID 1082) builds a JS `Date` at
 * UTC midnight for the given calendar date, which then renders as the
 * *previous* day in any timezone behind UTC (`toISOString().slice(0, 10)` on
 * a UTC-midnight `Date` viewed from a negative offset is one day early). The
 * membership-expiry rule compares civil dates as exact `YYYY-MM-DD` strings
 * (see `domain/membership.js`), so that shift would silently corrupt the
 * comparison. Registering the identity parser keeps every `date` column the
 * exact string PostgreSQL sent, with no timezone interpretation at all.
 *
 * Must run before any query executes, so it is imported for its side effect
 * at the top of `db/knex.js`, ahead of the knex instance being created.
 */
pg.types.setTypeParser(1082, (value) => value);
