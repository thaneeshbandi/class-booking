import { grantAppTablePrivileges } from '../src/db/grants.js';

/**
 * 003 — members (people who book).
 *
 * Deliberately NO unique constraint on email. A member is identified by its
 * row, never by its address: one parent's email on two children's memberships
 * is ordinary in a studio, and each row carries its own expiry date and so its
 * own goal-10 alert. Members do not log in, so there is no authentication
 * reason for uniqueness either.
 *
 * `members_email_normalised` survives as storage hygiene only — it no longer
 * enables any uniqueness.
 */

export async function up(knex) {
  await knex.raw(String.raw`
    CREATE TABLE members (
      id                    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      full_name             text        NOT NULL,
      email                 text        NOT NULL,
      membership_expires_on date        NOT NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT members_email_normalised CHECK (email = lower(btrim(email))),
      CONSTRAINT members_email_shape      CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
      CONSTRAINT members_name_present     CHECK (btrim(full_name) <> '')
    )
  `);

  // The goal-10 badge count runs on every page load, which makes it the
  // highest-frequency query in the application — the one index here sized for
  // future volume rather than present need.
  await knex.raw(`
    CREATE INDEX members_membership_expires_on ON members (membership_expires_on)
  `);

  await grantAppTablePrivileges(knex, 'members');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS members');
}
