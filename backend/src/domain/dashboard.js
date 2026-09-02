import { BOOKING_STATUSES } from '../routes/bookings.js';

/**
 * Goal 8 — dashboard aggregate queries. Every metric here is one small,
 * self-contained SQL aggregate query; none of them fetch raw rows into
 * JavaScript to count or group there.
 *
 * Time-window predicates are written as sargable ranges against the raw
 * indexed column (`starts_at`/`created_at`) — `col >= windowStart AND col <
 * windowStart + interval` — rather than wrapping the column itself in an
 * expression (`(col AT TIME ZONE tz)::date = today`), which would make the
 * existing `sessions_starts_at`/`bookings_created_at` indexes unusable for
 * this query. `date_trunc('day'|'week', now() AT TIME ZONE tz) AT TIME
 * ZONE tz` is the same "local civil boundary, as a real instant" idiom
 * already used for recurring-session generation (`routes/sessions.js`) and
 * the studio-today boolean (`bookingTransaction.js#lockSessionForBooking`),
 * just built from `date_trunc` instead of a literal local-time string —
 * `now()`/`date_trunc`/`AT TIME ZONE` are all STABLE or IMMUTABLE, so
 * Postgres evaluates the boundary expression once per query, not once per
 * row.
 *
 * Every function takes `queryable` (the shared `db`, or an open transaction
 * if one were ever needed) as its first argument, matching every other
 * domain module in this codebase.
 */

/** "sessions today" — keyed by the session's own scheduled instant
 * (`sessions.starts_at`), inside the studio's current civil day. */
export async function countSessionsToday(queryable, timeZone) {
  const { rows } = await queryable.raw(
    `SELECT count(*) AS count
     FROM sessions
     WHERE starts_at >= (date_trunc('day', now() AT TIME ZONE ?) AT TIME ZONE ?)
       AND starts_at <  (date_trunc('day', now() AT TIME ZONE ?) AT TIME ZONE ?) + interval '1 day'`,
    [timeZone, timeZone, timeZone, timeZone],
  );
  return Number(rows[0].count);
}

/** "bookings made today" — keyed by when the booking was *created*
 * (`bookings.created_at`), not by its current status or the session it's
 * for. A booking created today counts even if it was cancelled again later
 * the same day — "made" is about creation, not current state. */
export async function countBookingsToday(queryable, timeZone) {
  const { rows } = await queryable.raw(
    `SELECT count(*) AS count
     FROM bookings
     WHERE created_at >= (date_trunc('day', now() AT TIME ZONE ?) AT TIME ZONE ?)
       AND created_at <  (date_trunc('day', now() AT TIME ZONE ?) AT TIME ZONE ?) + interval '1 day'`,
    [timeZone, timeZone, timeZone, timeZone],
  );
  return Number(rows[0].count);
}

/** "no-shows this week" — keyed by the *session's* scheduled instant, not
 * by when the booking was created or settled. A no-show is an attribute of
 * the session that happened, not of the paperwork around it — settling a
 * booking `no_show` days after a session that ran three weeks ago must not
 * make it appear in *this* week's count. "This week" is the ISO 8601 week
 * (Monday 00:00 through the following Monday 00:00, studio-local, exclusive
 * of the end) containing the current instant. */
export async function countNoShowsThisWeek(queryable, timeZone) {
  const { rows } = await queryable.raw(
    `SELECT count(*) AS count
     FROM bookings
     JOIN sessions ON sessions.id = bookings.session_id
     WHERE bookings.status = 'no_show'
       AND sessions.starts_at >= (date_trunc('week', now() AT TIME ZONE ?) AT TIME ZONE ?)
       AND sessions.starts_at <  (date_trunc('week', now() AT TIME ZONE ?) AT TIME ZONE ?) + interval '1 week'`,
    [timeZone, timeZone, timeZone, timeZone],
  );
  return Number(rows[0].count);
}

/** "members currently waitlisted" — distinct *members*, not waitlisted
 * *bookings*: a member waitlisted on two different sessions at once is one
 * person still waiting, not two. */
export async function countMembersWaitlisted(queryable) {
  const row = await queryable('bookings')
    .where('status', 'waitlisted')
    .countDistinct({ count: 'member_id' })
    .first();
  return Number(row.count);
}

/** Every booking status, always, defaulting to 0 — never a missing key —
 * so a status with no bookings yet renders as a zero-height bar, not a gap. */
export async function getBookingsByStatus(queryable) {
  const rows = await queryable('bookings').select('status').count({ count: '*' }).groupBy('status');
  const byStatus = Object.fromEntries(BOOKING_STATUSES.map((status) => [status, 0]));
  for (const row of rows) {
    byStatus[row.status] = Number(row.count);
  }
  return byStatus;
}

/** Only classes with at least one booking appear — an all-time breakdown
 * over what actually exists, not a padded list of every class ever created
 * (archived or otherwise). Ordered by count so the busiest class leads. */
export async function getBookingsByClass(queryable) {
  const rows = await queryable('bookings')
    .join('sessions', 'sessions.id', 'bookings.session_id')
    .join('classes', 'classes.id', 'sessions.class_id')
    .select('classes.id as class_id', 'classes.title as class_title')
    .count({ count: 'bookings.id' })
    .groupBy('classes.id', 'classes.title')
    .orderBy('count', 'desc')
    .orderBy('classes.title', 'asc');
  return rows.map((row) => ({
    classId: row.class_id,
    classTitle: row.class_title,
    count: Number(row.count),
  }));
}

/** The 8 week-buckets this chart always returns, oldest first, ending with
 * the current (possibly still in progress) week. */
export const ATTENDANCE_WEEKS = 8;

/**
 * "Attendance per week, over the last eight weeks" — a count of `attended`
 * bookings per week, bucketed by the *session's* scheduled week
 * (studio-local), for the `ATTENDANCE_WEEKS` most recent weeks including
 * the current one.
 *
 * `generate_series` produces exactly `ATTENDANCE_WEEKS` week-start rows
 * regardless of whether any session/booking exists in a given week, and the
 * two `LEFT JOIN`s (never `JOIN`) are what makes an empty week come back as
 * `count: 0` rather than being silently omitted — the brief's own
 * requirement that this is a fixed eight-week chart, not a list of however
 * many weeks happen to have data.
 */
export async function getAttendancePerWeek(queryable, timeZone) {
  const { rows } = await queryable.raw(
    `SELECT weeks.week_start::date AS week_start, count(bookings.id) AS count
     FROM generate_series(
       date_trunc('week', now() AT TIME ZONE ?) - interval '7 weeks',
       date_trunc('week', now() AT TIME ZONE ?),
       interval '1 week'
     ) AS weeks(week_start)
     LEFT JOIN sessions
       ON sessions.starts_at >= (weeks.week_start AT TIME ZONE ?)
      AND sessions.starts_at <  (weeks.week_start AT TIME ZONE ?) + interval '1 week'
     LEFT JOIN bookings
       ON bookings.session_id = sessions.id AND bookings.status = 'attended'
     GROUP BY weeks.week_start
     ORDER BY weeks.week_start ASC`,
    [timeZone, timeZone, timeZone, timeZone],
  );
  return rows.map((row) => ({ weekStart: row.week_start, count: Number(row.count) }));
}
