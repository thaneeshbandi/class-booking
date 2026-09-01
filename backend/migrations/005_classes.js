import { grantAppTablePrivileges } from '../src/db/grants.js';

/**
 * 005 — classes.
 *
 * `archived_at timestamptz NULL` rather than a boolean: it carries *when*, and
 * restore is `SET archived_at = NULL`. Goal 2 requires both directions.
 * Archiving never deletes — nothing cascades from `classes` and
 * `sessions.class_id` is RESTRICT, so sessions and bookings survive by
 * construction.
 *
 * Duration is required positive with no upper bound. The brief requires a
 * duration and names no maximum, so the schema imposes none; the overlap query
 * in goal 7 is written to be correct for any duration rather than depending on
 * one.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE classes (
      id                       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      title                    text        NOT NULL,
      description              text        NOT NULL DEFAULT '',
      discipline               text        NOT NULL,
      default_duration_minutes integer     NOT NULL,
      default_capacity         integer     NOT NULL,
      archived_at              timestamptz,
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT classes_title_present      CHECK (btrim(title) <> ''),
      CONSTRAINT classes_discipline_present CHECK (btrim(discipline) <> ''),
      CONSTRAINT classes_duration_positive  CHECK (default_duration_minutes >= 1),
      CONSTRAINT classes_capacity_positive  CHECK (default_capacity > 0)
    )
  `);

  await grantAppTablePrivileges(knex, 'classes');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS classes');
}
