/**
 * 012 — links a login identity (`users`) to a booking identity (`members`).
 *
 * `003_members.js` deliberately did not give `members.email` a uniqueness
 * constraint (one parent's email on two children's memberships is ordinary),
 * so email can never be the standing identity relationship between a `users`
 * row and a `members` row — only the one-time signal used to find a match at
 * signup. The actual relationship is this column: a nullable, unique foreign
 * key on `members` pointing at the `users` row that may have claimed it.
 *
 * Nullable because most existing `members` rows were created by staff and
 * have no login at all — that stays true after this migration; nothing here
 * back-fills a value. Unique because the relationship is at most one-to-one
 * in both directions: one login can claim at most one member record, and one
 * member record can be claimed by at most one login (enforced by the unique
 * index below, not just application logic).
 *
 * `ON DELETE SET NULL` rather than `CASCADE`: there is no user-deletion
 * feature in this application, but if a `users` row were ever removed, the
 * member's booking history and membership data must survive that — the
 * member just becomes unclaimed again, exactly like a staff-created member
 * who never signed up.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE members
      ADD COLUMN user_id bigint REFERENCES users(id) ON DELETE SET NULL,
      ADD CONSTRAINT members_user_id_unique UNIQUE (user_id)
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE members
      DROP CONSTRAINT IF EXISTS members_user_id_unique,
      DROP COLUMN IF EXISTS user_id
  `);
}
