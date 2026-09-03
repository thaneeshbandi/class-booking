import { env } from '../config/env.js';

/**
 * What a public signup does to the `members` table. Called from inside the
 * same transaction that inserts the new `users` row (see `routes/auth.js`),
 * so a user is never created without a linked-or-created member, and a
 * member is never linked or created without the user it now belongs to.
 *
 * Matching is by normalized email against *unlinked* members only
 * (`user_id IS NULL`), locked `FOR UPDATE` so two concurrent signups can
 * never both claim the same row. A member already linked to a different
 * login is never touched — combined with `users.email` uniqueness (which
 * means a second signup with that same email can never even reach this
 * function; the `INSERT INTO users` above it already fails with a unique
 * violation, translated to 409 by the caller), this is what makes "another
 * user's member record cannot be claimed" hold as a database-enforced
 * property, not just an unchecked assumption.
 *
 * `members.email` is deliberately *not* unique (see `003_members.js` — one
 * parent's email on two children's memberships is ordinary), so more than
 * one unlinked member can legitimately share a normalized email. Guessing
 * which one a signing-up person meant would risk silently attaching a
 * stranger's booking history and membership expiry to the wrong account, so
 * an ambiguous match (more than one candidate) falls back to creating a
 * fresh member rather than linking to any of them. See `docs/decisions.md`.
 */
export async function linkOrCreateMemberForSignup(trx, { userId, fullName, email }) {
  const candidates = await trx('members').where({ email }).whereNull('user_id').forUpdate();

  if (candidates.length === 1) {
    // Staff-maintained data is never overwritten by what the signup form
    // submitted: full_name and membership_expires_on are left exactly as
    // staff set them, so existing membership expiry and every booking
    // already attached to this member row survive the link untouched.
    const [member] = await trx('members')
      .where({ id: candidates[0].id })
      .update({ user_id: userId, updated_at: trx.fn.now() })
      .returning('*');
    return { member, outcome: 'linked' };
  }

  // Zero matches (the ordinary new-signup case) or more than one (the rare
  // ambiguous case) both create a fresh member row, using the signup's own
  // name. A brand-new self-registered member starts with no granted
  // membership — `membership_expires_on` is set to *yesterday* (studio
  // time), not today: `domain/membership.js#isMembershipExpired` is a
  // strict `<` ("an expiry date equal to today is still valid"), so today's
  // date would leave a fresh signup bookable for the rest of that civil
  // day — a one-day free membership, not "no free membership just for
  // signing up." Yesterday is genuinely, immediately expired under that
  // same rule, until staff actually grants a real membership. See
  // `docs/decisions.md`.
  const [member] = await trx('members')
    .insert({
      user_id: userId,
      full_name: fullName,
      email,
      membership_expires_on: trx.raw("(now() AT TIME ZONE ?)::date - 1", [env.STUDIO_TIMEZONE]),
    })
    .returning('*');
  return { member, outcome: candidates.length > 1 ? 'ambiguous_new' : 'created' };
}
