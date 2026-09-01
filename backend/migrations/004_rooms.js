import { grantAppTablePrivileges } from '../src/db/grants.js';

/**
 * 004 — rooms.
 *
 * A table rather than a free-text column for one requirement-driven reason:
 * goal 7 must detect that a room was already booked in an overlapping window,
 * and free text defeats that the first time someone types "Studio A" and
 * "studio a".
 *
 * Deliberate contrast with `users.email`: room names are display strings where
 * casing matters, so they are not force-lowercased. A `lower(name)` expression
 * index gives case-insensitive uniqueness while preserving display casing.
 *
 * No `capacity` column — it would create an invariant the brief never states
 * (`session.capacity <= room.capacity`) and contradict goal 3, where session
 * capacity defaults from the class. Session capacity is the sole seat authority.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE rooms (
      id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name        text        NOT NULL,
      archived_at timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT rooms_name_present CHECK (name = btrim(name) AND name <> '')
    )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX rooms_name_ci_unique ON rooms (lower(name))
  `);

  await grantAppTablePrivileges(knex, 'rooms');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS rooms');
}
