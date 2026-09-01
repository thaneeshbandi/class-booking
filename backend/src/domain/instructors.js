/**
 * Shared instructor-validity check, used wherever a user id is being bound to
 * a session as an instructor — as primary (`sessions.js`, goal 3) or as a
 * co-instructor (`sessionCoInstructors.js`, goal 5). Pulled out of
 * `sessions.js` into its own module rather than exported from there, so the
 * two route files don't import each other.
 */

/** An instructor may only be assigned — as primary or co-instructor — if
 * they are, right now, an active account with the instructor role — never
 * staff, never a deactivated login. */
export function findActiveInstructor(queryable, instructorId) {
  return queryable('users')
    .where({ id: instructorId, role: 'instructor', is_active: true })
    .first();
}
