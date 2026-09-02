/**
 * Goal 10 — membership expiry alerts.
 *
 * The canonical predicate below is unchanged from the one already documented
 * against `member_alert_dismissals` when that table was first migrated
 * (`010_member_alert_dismissals.js`): a member alerts when their expiry date
 * is on or before studio-local today + 7 days, and there is no dismissal row
 * for that member whose `dismissed_expiry_date` equals their *current*
 * expiry date. Changing the expiry date invalidates any old dismissal
 * automatically — the anti-join simply stops matching a different date —
 * with no reset logic, background job, or mutable flag anywhere.
 *
 * Every function here takes `queryable` (the shared `db`, or an open
 * transaction) as its first argument, matching every other domain module in
 * this codebase.
 */

/**
 * Every member currently alerting, oldest-expiry-first. The filtering (the
 * window bound and the anti-join against dismissals) happens entirely in
 * this one query — nothing downstream re-filters in JavaScript. Each row
 * also carries `studio_today`, the same instant used to decide the window,
 * so a caller can derive `isExpired`/`daysUntilExpiry` per row
 * (`domain/membership.js`) without a second round trip.
 */
export async function listExpiringMemberAlerts(queryable, timeZone) {
  const { rows } = await queryable.raw(
    `SELECT
       m.id,
       m.full_name,
       m.email,
       m.membership_expires_on,
       (now() AT TIME ZONE ?)::date AS studio_today
     FROM members m
     WHERE m.membership_expires_on <= ((now() AT TIME ZONE ?)::date + 7)
       AND NOT EXISTS (
         SELECT 1 FROM member_alert_dismissals d
         WHERE d.member_id = m.id
           AND d.dismissed_expiry_date = m.membership_expires_on
       )
     ORDER BY m.membership_expires_on ASC, m.id ASC`,
    [timeZone, timeZone],
  );
  return rows;
}

/**
 * Studio-local today and the alert window's end (today + 7 days), both as
 * exact `YYYY-MM-DD` strings computed by PostgreSQL — the one place this
 * project ever adds "7 days" to a date, reused by the dismissal endpoint's
 * in-window check (`domain/membership.js#isWithinAlertWindow`) rather than
 * re-expressed a second time.
 */
export async function getAlertWindowBounds(queryable, timeZone) {
  const { rows } = await queryable.raw(
    `SELECT (now() AT TIME ZONE ?)::date AS today,
            (now() AT TIME ZONE ?)::date + 7 AS window_end`,
    [timeZone, timeZone],
  );
  return { today: rows[0].today, windowEnd: rows[0].window_end };
}
