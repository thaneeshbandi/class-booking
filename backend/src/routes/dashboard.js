import { Router } from 'express';

import {
  countBookingsToday,
  countMembersWaitlisted,
  countNoShowsThisWeek,
  countSessionsToday,
  getAttendancePerWeek,
  getBookingsByClass,
  getBookingsByStatus,
} from '../domain/dashboard.js';
import { env } from '../config/env.js';
import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';

/**
 * Goal 8 — the dashboard.
 *
 * Staff-only. The brief describes this as the studio's "landing view" —
 * headline operational numbers, a bookings-by-status/by-class breakdown,
 * and an attendance chart — every one of them a studio-wide aggregate with
 * no session/class/instructor scoping in it at all, the same kind of
 * studio-wide visibility `GET /api/members` already restricts to staff.
 * Nothing in the brief asks for an instructor-facing version of this view
 * (an instructor's own view is "every session where they are the primary
 * instructor or a co-instructor", goal 5's existing scoping — a fundamentally
 * different, narrower shape than "sessions today across every room"), so
 * exposing any of it to instructors would be inventing capability the brief
 * never asked for. See `docs/decisions.md`.
 *
 * All seven metrics are independent read-only aggregate queries
 * (`domain/dashboard.js`), run concurrently with `Promise.all` against the
 * connection pool — safe here the same way `GET /api/bookings`'s count/page
 * queries already run concurrently (Decision 7): these are separate pool
 * connections, not one shared transaction, so nothing here is at risk of the
 * "no concurrent queries on one `pg` connection" rule that applies inside a
 * `db.transaction`.
 */

const router = Router();

router.use(authenticate);

router.get('/', requireRole('staff'), async (_req, res, next) => {
  try {
    const timeZone = env.STUDIO_TIMEZONE;
    const [
      sessionsToday,
      bookingsToday,
      noShowsThisWeek,
      membersWaitlisted,
      bookingsByStatus,
      bookingsByClass,
      attendancePerWeek,
    ] = await Promise.all([
      countSessionsToday(db, timeZone),
      countBookingsToday(db, timeZone),
      countNoShowsThisWeek(db, timeZone),
      countMembersWaitlisted(db),
      getBookingsByStatus(db),
      getBookingsByClass(db),
      getAttendancePerWeek(db, timeZone),
    ]);

    res.json({
      headline: { sessionsToday, bookingsToday, noShowsThisWeek, membersWaitlisted },
      bookingsByStatus,
      bookingsByClass,
      attendancePerWeek,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
