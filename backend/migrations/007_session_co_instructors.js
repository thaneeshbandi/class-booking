import { grantAppTablePrivileges } from '../src/db/grants.js';

/**
 * 007 — session_co_instructors: the schema's only many-to-many.
 *
 * "Primary instructor is not also a co-instructor" is enforced by the database,
 * not the service layer. The session's primary instructor is denormalised into
 * the join row and bound by a composite foreign key with ON UPDATE CASCADE:
 *
 *   - inserting the primary as a co-instructor fails the CHECK immediately;
 *   - re-pointing `sessions.primary_instructor_id` at a current co-instructor
 *     cascades the new value into that join row, where the same CHECK rejects
 *     it and the whole transaction aborts. The application must remove the
 *     co-instructor row first, in the same transaction.
 *
 * Rejected alternative: a pair of triggers. Each would read the *other* table,
 * so under READ COMMITTED two concurrent transactions — one adding a
 * co-instructor, one changing the primary — can each pass and commit a
 * violating state. The foreign key has no such window: it takes a row lock on
 * the referenced `sessions` row, serialising the two.
 *
 * Cost, stated plainly: one redundant bigint per join row plus the extra unique
 * index on `sessions`. The composite primary key IS the pair-uniqueness
 * constraint; no surrogate id, because the pair is the natural key.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE session_co_instructors (
      session_id                    bigint      NOT NULL,
      user_id                       bigint      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      session_primary_instructor_id bigint      NOT NULL,
      added_at                      timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (session_id, user_id),

      CONSTRAINT session_co_instructors_session_fk
        FOREIGN KEY (session_id, session_primary_instructor_id)
        REFERENCES sessions (id, primary_instructor_id)
        ON UPDATE CASCADE ON DELETE CASCADE,

      CONSTRAINT co_instructor_is_not_primary
        CHECK (user_id <> session_primary_instructor_id)
    )
  `);

  // The other half of an instructor's own-sessions list: sessions where I am a
  // co-instructor rather than the primary.
  await knex.raw(`
    CREATE INDEX session_co_instructors_user
      ON session_co_instructors (user_id, session_id)
  `);

  await grantAppTablePrivileges(knex, 'session_co_instructors');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS session_co_instructors');
}
