import { grantAppTablePrivileges } from '../src/db/grants.js';

/**
 * 008 — bookings.
 *
 * No `booked_count` column anywhere. Occupancy is derived by counting under the
 * session row lock (`SELECT ... FROM sessions WHERE id = $1 FOR UPDATE`), which
 * cannot drift the way a maintained counter can.
 *
 * The five statuses partition into three sets:
 *   Active            — booked, waitlisted   (a live claim on this session)
 *   Occupies a seat   — booked, attended, no_show
 *   Historical        — cancelled, attended, no_show
 *
 * The active-booking index uses exactly the active set. The rule it states is
 * "at most one *simultaneously active* booking per member per session"; the
 * broader `status <> 'cancelled'` would express a different rule — "at most one
 * non-cancelled booking ever" — and smuggle a settlement-era restriction into a
 * constraint about live claims.
 *
 * The narrow predicate leaves no exploitable window because two application
 * rules are disjoint: a booking cannot be created once the session has started,
 * and settlement is only permitted once it has finished. At creation time any
 * earlier booking by that member is therefore still booked, waitlisted or
 * cancelled — never yet settled.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE bookings (
      id         bigint         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      session_id bigint         NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
      member_id  bigint         NOT NULL REFERENCES members(id)  ON DELETE RESTRICT,
      status     booking_status NOT NULL,
      created_at timestamptz    NOT NULL DEFAULT now(),
      updated_at timestamptz    NOT NULL DEFAULT now()
    )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX bookings_one_active_per_member_session
      ON bookings (session_id, member_id)
      WHERE status IN ('booked', 'waitlisted')
  `);

  // Occupancy count under lock; per-session status filters; attendance CSV.
  await knex.raw(`
    CREATE INDEX bookings_session_status ON bookings (session_id, status)
  `);

  // Default sort and pagination (goal 6); "bookings made today" (goal 8).
  // (created_at, id) rather than (created_at) so keyset pagination is available
  // later without a new index.
  await knex.raw(`CREATE INDEX bookings_created_at ON bookings (created_at, id)`);

  // Member-search join target; a member's booking history.
  await knex.raw(`CREATE INDEX bookings_member ON bookings (member_id)`);

  // Waitlist FIFO promotion and "members currently waitlisted" (goals 4, 8).
  // `created_at` IS the waitlist join time: no allowed transition moves a
  // booking *into* waitlisted after creation, so no waitlisted_at column is
  // needed. `id` is the deterministic tie-break. The partial predicate keeps
  // the index tiny and self-cleaning.
  await knex.raw(`
    CREATE INDEX bookings_waitlist_fifo
      ON bookings (session_id, created_at, id)
      WHERE status = 'waitlisted'
  `);

  await grantAppTablePrivileges(knex, 'bookings');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS bookings');
}
