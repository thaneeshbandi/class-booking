import { grantAppTablePrivileges } from '../src/db/grants.js';

/**
 * 002 — users (staff and instructor logins).
 *
 * Case-insensitive login uniqueness without `citext` or an expression index:
 * `users_email_normalised` makes lowercase-and-trimmed storage a database
 * guarantee, which in turn makes a plain `UNIQUE (email)` a genuine
 * case-insensitive constraint. One index, no extension.
 *
 * This is the only email uniqueness in the schema — `members.email` is
 * deliberately not unique (see 003).
 */

export async function up(knex) {
  await knex.raw(String.raw`
    CREATE TABLE users (
      id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email         text        NOT NULL,
      password_hash text        NOT NULL,
      full_name     text        NOT NULL,
      role          user_role   NOT NULL,
      is_active     boolean     NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT users_email_unique     UNIQUE (email),
      CONSTRAINT users_email_normalised CHECK (email = lower(btrim(email))),
      CONSTRAINT users_email_shape      CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
      CONSTRAINT users_name_present     CHECK (btrim(full_name) <> ''),
      -- Every Argon2/bcrypt PHC string starts with '$'; no plausible plaintext
      -- does. Algorithm and cost live inside the string, so rehash-on-login
      -- never needs a migration.
      CONSTRAINT users_hash_not_plain   CHECK (password_hash LIKE '$%')
    )
  `);

  await grantAppTablePrivileges(knex, 'users');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS users');
}
