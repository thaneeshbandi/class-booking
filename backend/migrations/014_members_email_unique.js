/**
 * 014 — `members.email` becomes unique.
 *
 * `003_members.js` deliberately left `members.email` non-unique: "one
 * parent's email on two children's memberships is ordinary in a studio."
 * That was a real, considered design choice at the time, not an oversight —
 * see `docs/decisions.md`'s account of it and of the account-linking design
 * (Decisions 32–34) that was later built to accommodate it.
 *
 * This migration reverses that choice, on an explicit, direct product
 * requirement: staff must not be able to create two member records that
 * share an email address. See `docs/decisions.md` for the full reasoning,
 * including why the two designs cannot coexist (a shared household email
 * across two memberships is now simply unsupported — each membership needs
 * its own address) and why a database-level constraint, not an
 * application-level "check first" guard, is the correct enforcement: a
 * `SELECT`-then-`INSERT` has an unavoidable race window between two
 * concurrent requests for the same email, and this table already has a
 * least-privilege application role (`APP_DB_ROLE`) for which the database
 * itself is the only enforcement that can never be bypassed by a bug in a
 * future route.
 *
 * `email` is already guaranteed normalized (trimmed, lower-cased) by
 * `members_email_normalised` — the same `CHECK` `users.email` uses — so a
 * plain `UNIQUE (email)` is already a case-/whitespace-insensitive
 * constraint, exactly like `users_email_unique`; no functional index is
 * needed.
 *
 * This migration will fail against a database that already has duplicate
 * `members.email` values — expected and correct: it is not this migration's
 * job to silently guess which of two conflicting rows should be kept. A
 * fresh `db:reset` (migrations before seeding) never hits this, since the
 * seed data itself no longer creates a duplicate (see
 * `seeds/001_demo_data.js`).
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE members
      ADD CONSTRAINT members_email_unique UNIQUE (email)
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE members
      DROP CONSTRAINT IF EXISTS members_email_unique
  `);
}
