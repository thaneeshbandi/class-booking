import { db } from '../db/knex.js';

/**
 * The single definition of "this session belongs to this instructor" —
 * primary instructor OR co-instructor, read fresh from the database. Both the
 * single-resource check below and every collection endpoint that needs to
 * scope sessions or bookings to "what this instructor can see" call this, so
 * a resource-level check and a list-scoping filter can never quietly drift
 * apart into two different definitions of ownership.
 */
export function scopeSessionsToInstructor(query, instructorId) {
  return query.where((qb) => {
    qb.where('sessions.primary_instructor_id', instructorId).orWhereExists(
      db('session_co_instructors')
        .select(1)
        .whereRaw('session_co_instructors.session_id = sessions.id')
        .andWhere('session_co_instructors.user_id', instructorId),
    );
  });
}

function isPositiveIntegerString(value) {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

/**
 * Route middleware: loads the session named by `req.params[paramName]` and
 * authorizes it against `req.user` (populated by `authenticate`, which must
 * run first). Staff may access any session. An instructor may access it only
 * if the database says, right now, that they are the primary instructor or a
 * co-instructor — never a cached role, never a claim inside the session
 * token, and never an id read from the request body. Removing a
 * co-instructor therefore revokes access on their very next request, and an
 * instructor cannot regain access to a session by putting a session id they
 * do own somewhere in the request body — only `req.params[paramName]` is
 * ever consulted.
 *
 * A session that does not exist is reported as 404; one that exists but the
 * caller is not authorized for is reported as 403. Staff and instructor
 * accounts are a small set of studio employees, not the general public, so
 * distinguishing the two is not treated as a resource-existence leak here.
 */
/**
 * The booking-level counterpart to `loadAuthorizedSession`: loads the booking
 * named by `bookingId`, then authorizes it through the booking's own
 * `session_id` — read from the database, never from a client-supplied
 * session id — using the exact same `scopeSessionsToInstructor` predicate a
 * session-level check would use. Booking and session ownership can therefore
 * never drift into two different definitions of "this instructor's own".
 *
 * `queryable` is either the shared `db` (a plain authorized read, e.g. GET)
 * or an open transaction (a re-check against a session row already locked
 * `FOR UPDATE`, e.g. settle) — the caller decides which guarantee it needs.
 *
 * Returns `{ error: 404 }`, `{ error: 403 }`, or `{ booking }`. A route
 * translates the `error` into a response; this never touches `req`/`res`
 * itself, so it is equally usable inside a transaction where there is no
 * response to short-circuit yet.
 */
export async function loadAuthorizedBooking(queryable, bookingId, user) {
  const booking = await queryable('bookings').where({ id: bookingId }).first();
  if (!booking) {
    return { error: 404 };
  }

  if (user.role !== 'staff') {
    const authorized = await queryable('sessions')
      .where({ id: booking.session_id })
      .modify(scopeSessionsToInstructor, user.id)
      .first();
    if (!authorized) {
      return { error: 403 };
    }
  }

  return { booking };
}

export function loadAuthorizedSession(paramName = 'sessionId') {
  return async (req, res, next) => {
    try {
      const sessionId = req.params[paramName];
      if (!isPositiveIntegerString(String(sessionId))) {
        return res.status(400).json({ error: 'Invalid session id.' });
      }

      const session = await db('sessions').where({ id: sessionId }).first();
      if (!session) {
        return res.status(404).json({ error: 'Session not found.' });
      }

      if (req.user.role !== 'staff') {
        const authorized = await db('sessions')
          .where({ id: sessionId })
          .modify(scopeSessionsToInstructor, req.user.id)
          .first();
        if (!authorized) {
          return res.status(403).json({ error: 'Forbidden.' });
        }
      }

      req.targetSession = session;
      next();
    } catch (error) {
      next(error);
    }
  };
}
