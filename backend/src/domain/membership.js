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

/**
 * Goal 10's alert-window predicate, left half: true once `membershipExpiresOn`
 * is on or before `windowEnd`. `windowEnd` is always `studioToday + 7 days`,
 * sourced from PostgreSQL date arithmetic (`(now() AT TIME ZONE tz)::date +
 * 7`, `domain/membershipAlerts.js#getAlertWindowBounds`) — never recomputed
 * here, so there is exactly one place day-count arithmetic against "today"
 * happens. Both arguments are exact `YYYY-MM-DD` strings, so — as with
 * `isMembershipExpired` above — lexicographic order is calendar order.
 */
export function isWithinAlertWindow(membershipExpiresOn, windowEnd) {
  return membershipExpiresOn <= windowEnd;
}

function toUtcMs(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Signed day count from `studioToday` to `membershipExpiresOn`: negative
 * once already expired, `0` on the day it expires, positive while still
 * valid. Both arguments are exact `YYYY-MM-DD` civil-date strings, parsed as
 * UTC-midnight anchors purely so subtraction gives a whole number of days —
 * no timezone reinterpretation is happening, the same way the test suite's
 * own `addDays` helpers already do calendar-date arithmetic.
 */
export function daysUntilExpiry(membershipExpiresOn, studioToday) {
  return Math.round((toUtcMs(membershipExpiresOn) - toUtcMs(studioToday)) / 86_400_000);
}
