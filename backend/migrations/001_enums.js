/**
 * 001 — enum types.
 *
 * Native enums rather than `text` + CHECK: enum values sort in declaration
 * order, so goal 6's "sort by status" yields lifecycle order (Booked →
 * Waitlisted → Cancelled → Attended → No Show) instead of alphabetical order,
 * which means nothing to a studio.
 *
 * Accepted cost: adding a value needs `ALTER TYPE ... ADD VALUE` and values
 * cannot be removed. Display strings ("No Show") are mapped in the application.
 */

export async function up(knex) {
  await knex.raw(`CREATE TYPE user_role AS ENUM ('staff', 'instructor')`);

  await knex.raw(`
    CREATE TYPE booking_status AS ENUM (
      'booked', 'waitlisted', 'cancelled', 'attended', 'no_show'
    )
  `);

  await knex.raw(`
    CREATE TYPE booking_event_type AS ENUM (
      'created', 'status_changed', 'note'
    )
  `);
}

export async function down(knex) {
  await knex.raw('DROP TYPE IF EXISTS booking_event_type');
  await knex.raw('DROP TYPE IF EXISTS booking_status');
  await knex.raw('DROP TYPE IF EXISTS user_role');
}
