/**
 * 011 — a third `user_role` value, `'member'`, for public self-service signup.
 *
 * `001_enums.js` already accepted this exact cost up front: "adding a value
 * needs `ALTER TYPE ... ADD VALUE` and values cannot be removed." This
 * migration is that addition, nothing more — every existing authorization
 * check in the application is either an explicit allowlist (`requireRole`)
 * or scopes a non-staff caller to sessions where their own user id is the
 * primary or a co-instructor (`scopeSessionsToInstructor`), which a
 * `'member'` account can never match. A signed-up member is therefore
 * authenticated but has no elevated access anywhere in the existing API —
 * this migration cannot, by itself, grant a new account any capability
 * `requireRole('staff')` or `requireRole('instructor', 'staff')` doesn't
 * already deny it.
 *
 * No down migration: Postgres cannot drop a single enum value (only the
 * whole type), matching `001_enums.js`'s own documented one-way cost.
 */

export async function up(knex) {
  await knex.raw(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'member'`);
}

export async function down() {
  // Deliberately a no-op — see file header. Any rows created with role
  // 'member' would also need handling before a real down migration could
  // exist, and none of that is needed for this addition's actual purpose.
}
