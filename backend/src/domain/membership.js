/**
 * A member is expired only once their membership has actually lapsed:
 * `membership_expires_on < studio_today`. An expiry date equal to today is
 * still valid — the member has until the end of that civil day.
 *
 * Both arguments are exact `YYYY-MM-DD` strings — `membershipExpiresOn` from
 * the `members.membership_expires_on` `date` column (safe only because of the
 * `db/pgTypes.js` parser fix; see the regression test in
 * `tests/bookingDomain.test.js`), and `studioToday` from
 * `(now() AT TIME ZONE STUDIO_TIMEZONE)::date` computed in PostgreSQL. For
 * this fixed-width format, lexicographic string order is calendar order, so
 * no `Date` parsing — and no timezone reinterpretation — is needed here.
 */
export function isMembershipExpired(membershipExpiresOn, studioToday) {
  return membershipExpiresOn < studioToday;
}
