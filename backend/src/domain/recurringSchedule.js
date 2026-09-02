/**
 * Pure calendar-date expansion for goal 7 recurring session generation.
 *
 * This module only expands *calendar dates* and filters them by weekday — no
 * timezone conversion happens here. Converting a candidate's local
 * wall-clock time into the stored `timestamptz` instant is deliberately left
 * to PostgreSQL's own `AT TIME ZONE` operator
 * (`local_string::timestamp AT TIME ZONE studio_timezone`), the same
 * mechanism `seeds/001_demo_data.js` already uses for exactly this problem.
 * Reusing it here means DST correctness rests on one implementation
 * (Postgres's IANA tzdata via `AT TIME ZONE`), not a second, hand-rolled one
 * in JavaScript that could quietly disagree with it.
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD` from calendar parts, zero-padded. */
export function formatDateStr(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Every candidate local date between `startDate` and `endDate` (inclusive,
 * both `YYYY-MM-DD`) whose weekday is in `weekdays` (0=Sunday..6=Saturday,
 * matching `Date.prototype.getDay()`), in chronological order.
 *
 * Walked as whole UTC calendar days purely to drive the iteration — no
 * timezone meaning is attached to the cursor itself, only to the local wall
 * time each resulting date is later combined with by the caller.
 */
export function expandCandidateDates({ startDate, endDate, weekdays }) {
  const weekdaySet = new Set(weekdays);
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
  const [endYear, endMonth, endDay] = endDate.split('-').map(Number);

  const dates = [];
  let cursor = Date.UTC(startYear, startMonth - 1, startDay);
  const end = Date.UTC(endYear, endMonth - 1, endDay);
  while (cursor <= end) {
    const d = new Date(cursor);
    if (weekdaySet.has(d.getUTCDay())) {
      dates.push(formatDateStr(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
    }
    cursor += 86_400_000;
  }
  return dates;
}

/**
 * `YYYY-MM-DD HH:MM:00` — the local wall-clock string PostgreSQL's
 * `::timestamp AT TIME ZONE ?` resolves to an instant, matching
 * `seeds/001_demo_data.js`'s `insertSession` helper.
 */
export function localTimestampString(date, localStartTime) {
  return `${date} ${localStartTime}:00`;
}
