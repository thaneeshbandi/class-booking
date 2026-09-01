import { grantAppTablePrivileges } from '../src/db/grants.js';

/**
 * 006 — sessions.
 *
 * Copy-on-create, not reference: `duration_minutes` and `capacity` are copied
 * from the class at insert time and never re-read. That is *how* "changing a
 * class default later must not change existing sessions" holds — there is no
 * live link to break. Nullable overrides falling back to the class would let a
 * class edit silently rewrite the capacity of every past session, corrupting
 * the attendance record.
 *
 * `starts_at` is an instant, never a local (date, time) pair: a local pair is
 * ambiguous on the autumn DST boundary and impossible on the spring one, while
 * ordering, overlap detection and "the session's scheduled time has passed" all
 * need a total order over real instants.
 *
 * No CHECK constrains `starts_at` relative to now(): staff may legitimately
 * record a session in the past. "No booking after a session has started" is a
 * booking-time precondition, not a property of the session row.
 *
 * No `ends_at` column. It is derived as
 * `starts_at + make_interval(mins => duration_minutes)`. It cannot be a stored
 * generated column or an expression index either, because `timestamptz +
 * interval` is STABLE rather than IMMUTABLE (interval arithmetic consults the
 * session TimeZone) and both require IMMUTABLE expressions.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE sessions (
      id                    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      class_id              bigint      NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
      primary_instructor_id bigint      NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
      room_id               bigint      NOT NULL REFERENCES rooms(id)   ON DELETE RESTRICT,
      starts_at             timestamptz NOT NULL,
      duration_minutes      integer     NOT NULL,
      capacity              integer     NOT NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT sessions_duration_positive CHECK (duration_minutes >= 1),
      CONSTRAINT sessions_capacity_positive CHECK (capacity > 0),

      -- Redundant as uniqueness (id is already the primary key). It exists
      -- solely as the target of the composite foreign key in 007, which is what
      -- lets the database enforce "primary instructor is not a co-instructor".
      CONSTRAINT sessions_id_instructor_key UNIQUE (id, primary_instructor_id)
    )
  `);

  // Instructor's own-sessions list (goal 5) and instructor conflict detection
  // (goal 7). Also serves the visibility predicate applied to every query.
  await knex.raw(`
    CREATE INDEX sessions_instructor_starts_at
      ON sessions (primary_instructor_id, starts_at)
  `);

  // "Opening a class shows its sessions", in time order (goal 3).
  await knex.raw(`
    CREATE INDEX sessions_class_starts_at ON sessions (class_id, starts_at)
  `);

  // Room conflict detection (goal 7).
  await knex.raw(`
    CREATE INDEX sessions_room_starts_at ON sessions (room_id, starts_at)
  `);

  // Dashboard day/week windows; upcoming-sessions view (goal 8).
  await knex.raw(`CREATE INDEX sessions_starts_at ON sessions (starts_at)`);

  await grantAppTablePrivileges(knex, 'sessions');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS sessions');
}
