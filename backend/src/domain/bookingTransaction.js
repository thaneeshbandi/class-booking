import { assertCanCancel, assertCanCreate } from './bookingTiming.js';
import { assertCancellable } from './bookingTransitions.js';
import { BookingError } from './bookingErrors.js';
import { isMembershipExpired } from './membership.js';
import { env } from '../config/env.js';

/**
 * Reusable booking-transaction primitives (phase P2). Every one of these
 * operates on an already-open `trx` and assumes the caller is following the
 * approved lock protocol: the session row is always locked first, booking
 * rows only after, and nothing here starts or commits a transaction itself.
 */

export const OCCUPYING_STATUSES = ['booked', 'attended', 'no_show'];
const SETTLED_STATUSES = ['attended', 'no_show'];

/**
 * The session-row mutex for the booking set, and the one Postgres-sourced
 * read of everything a booking mutation needs to decide anything: `FOR
 * UPDATE` acquires the lock; `has_started`/`has_finished`/`studio_today` are
 * computed by Postgres in the same round trip, per the approved design's
 * "time rules must come from PostgreSQL time, not JavaScript Date.now()".
 *
 * Returns `undefined` if the session does not exist — callers 404 on that.
 */
export async function lockSessionForBooking(trx, sessionId) {
  const { rows } = await trx.raw(
    `
    SELECT
      id,
      class_id            AS "classId",
      primary_instructor_id AS "primaryInstructorId",
      room_id             AS "roomId",
      starts_at           AS "startsAt",
      duration_minutes    AS "durationMinutes",
      capacity,
      now() >= starts_at AS "hasStarted",
      now() >= starts_at + make_interval(mins => duration_minutes) AS "hasFinished",
      to_char((now() AT TIME ZONE ?), 'YYYY-MM-DD') AS "studioToday"
    FROM sessions
    WHERE id = ?
    FOR UPDATE
    `,
    [env.STUDIO_TIMEZONE, sessionId],
  );
  return rows[0];
}

/** Seats currently occupied: booked, attended, or no_show. Never waitlisted or cancelled. */
export async function countOccupiedSeats(trx, sessionId) {
  const [{ count }] = await trx('bookings')
    .where({ session_id: sessionId })
    .whereIn('status', OCCUPYING_STATUSES)
    .count({ count: '*' });
  return Number(count);
}

/** Bookings whose attendance has been settled — the gate for the reschedule rule (P6). */
export async function countSettledBookings(trx, sessionId) {
  const [{ count }] = await trx('bookings')
    .where({ session_id: sessionId })
    .whereIn('status', SETTLED_STATUSES)
    .count({ count: '*' });
  return Number(count);
}

/** A single booking row, locked for update. Only ever called after the session lock is held. */
export function loadBookingForUpdate(trx, bookingId) {
  return trx('bookings').where({ id: bookingId }).forUpdate().first();
}

/**
 * Inserts one `booking_events` row. The three shapes below are exactly what
 * the `booking_events_well_formed` CHECK constraint (009_booking_events.js)
 * accepts; this is the one place the application constructs them, so a typo
 * fails loudly against the database rather than drifting from the constraint
 * silently in application code.
 */
export function writeBookingEvent(
  trx,
  {
    bookingId,
    eventType,
    fromStatus = null,
    toStatus = null,
    note = null,
    actorUserId = null,
    isAutomatic = false,
    causedByBookingId = null,
  },
) {
  return trx('booking_events').insert({
    booking_id: bookingId,
    event_type: eventType,
    from_status: fromStatus,
    to_status: toStatus,
    note,
    actor_user_id: actorUserId,
    is_automatic: isAutomatic,
    caused_by_booking_id: causedByBookingId,
  });
}

/**
 * Promotes up to `freeSeats` FIFO-earliest waitlisted bookings to `booked`,
 * writing each an automatic `status_changed` event. Must only be called
 * while the caller already holds the session's `FOR UPDATE` lock — this
 * function never acquires it. Deliberately no `SKIP LOCKED`: the session
 * mutex already serializes every writer against this session's bookings, so
 * there is nothing else that could be holding a conflicting lock on them.
 *
 * `causedByBookingId` is the cancelled booking's id for a cancellation-
 * triggered promotion, or `null` for a capacity-increase promotion — the
 * same distinction the `booking_events_cause_requires_automatic` /
 * `..._cause_is_not_self` constraints expect.
 *
 * Promotions run as a sequential `for`-loop, not `Promise.all`: `trx` is one
 * dedicated connection, and firing concurrent queries down it is unsupported
 * by `pg`, mirroring `domain/sessionConflicts.js`'s existing rule for the
 * same reason.
 */
export async function promoteWaitlistFIFO(
  trx,
  { sessionId, freeSeats, actorUserId, causedByBookingId = null },
) {
  if (freeSeats <= 0) return [];

  const candidates = await trx('bookings')
    .where({ session_id: sessionId, status: 'waitlisted' })
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(freeSeats)
    .forUpdate();

  const promoted = [];
  for (const candidate of candidates) {
    const [updated] = await trx('bookings')
      .where({ id: candidate.id })
      .update({ status: 'booked', updated_at: trx.fn.now() })
      .returning('*');
    await writeBookingEvent(trx, {
      bookingId: candidate.id,
      eventType: 'status_changed',
      fromStatus: 'waitlisted',
      toStatus: 'booked',
      actorUserId,
      isAutomatic: true,
      causedByBookingId,
    });
    promoted.push(updated);
  }
  return promoted;
}

/**
 * Maps a raw Postgres error from inside a booking/session transaction to a
 * clean `BookingError`, or returns `null` for anything else — the caller
 * rethrows the original in that case, so an unrecognized failure still
 * surfaces as a 500 rather than being silently swallowed.
 *
 * `23505` (unique violation): the partial unique index on
 * `(session_id, member_id)` is the database backstop behind the pre-check
 * `POST /api/bookings` already does under the session lock; unreachable in
 * practice given that lock, kept as a last line of defense per the approved
 * design.
 *
 * `23503` (foreign key violation): every id this application inserts against
 * a booking is validated to exist earlier in the same transaction, so this
 * is likewise not expected to be reachable through normal use — but a raw
 * FK violation must never reach a client as an unexplained 500.
 *
 * `55P03` (lock not available): only possible where `SET LOCAL lock_timeout`
 * is in effect (see the booking and session-mutation transactions). A busy
 * session row is a legitimate, retryable condition, not a server error.
 */
export function translateBookingPgError(error) {
  if (error?.code === '23505') {
    return new BookingError(409, 'This member already has an active booking for this session.');
  }
  if (error?.code === '23503') {
    return new BookingError(409, 'This booking references a record that no longer exists.');
  }
  if (error?.code === '55P03') {
    return new BookingError(409, 'This session is busy right now; please try again.');
  }
  return null;
}

/**
 * The single booking-creation transaction body, used by both the staff
 * route (`routes/bookings.js`, `memberId` from the request body) and the
 * member-portal route (`routes/memberBookings.js`, `memberId` derived
 * server-side from the authenticated user's own linked member row) — so the
 * two can never diverge on capacity, waitlist, or membership-expiry rules.
 * Callers open the transaction and set the lock timeout; this only runs the
 * decision inside it. Throws `BookingError` for every rejection.
 */
export async function createBookingInTransaction(trx, { sessionId, memberId, actorUserId }) {
  const session = await lockSessionForBooking(trx, sessionId);
  if (!session) {
    throw new BookingError(404, 'Session not found.');
  }
  assertCanCreate({ hasStarted: session.hasStarted });

  const member = await trx('members').where({ id: memberId }).first();
  if (!member) {
    throw new BookingError(400, 'Unknown member id.');
  }
  if (isMembershipExpired(member.membership_expires_on, session.studioToday)) {
    throw new BookingError(409, `This member's membership expired on ${member.membership_expires_on}.`);
  }

  const existingActive = await trx('bookings')
    .where({ session_id: sessionId, member_id: memberId })
    .whereIn('status', ['booked', 'waitlisted'])
    .first();
  if (existingActive) {
    throw new BookingError(409, 'This member already has an active booking for this session.');
  }

  const occupied = await countOccupiedSeats(trx, sessionId);
  const status = occupied < session.capacity ? 'booked' : 'waitlisted';

  const [booking] = await trx('bookings')
    .insert({ session_id: sessionId, member_id: memberId, status })
    .returning('id');
  await writeBookingEvent(trx, {
    bookingId: booking.id,
    eventType: 'created',
    toStatus: status,
    actorUserId,
  });
  return booking.id;
}

/**
 * The single booking-cancellation transaction body — same reuse rationale as
 * `createBookingInTransaction` above, shared by the staff cancel route and
 * the member-portal cancel route. Ownership authorization (a member may only
 * cancel their own booking) is the caller's responsibility, checked *before*
 * calling this: `member_id` is immutable once a booking is created (no route
 * ever updates it), so reading it unlocked ahead of the transaction is safe.
 * Returns the ids of any bookings promoted off the waitlist as a result.
 */
export async function cancelBookingInTransaction(trx, { bookingId, actorUserId, note }) {
  const peek = await trx('bookings').where({ id: bookingId }).first('session_id');
  if (!peek) {
    throw new BookingError(404, 'Booking not found.');
  }

  const session = await lockSessionForBooking(trx, peek.session_id);
  const booking = await loadBookingForUpdate(trx, bookingId);
  if (!booking) {
    throw new BookingError(404, 'Booking not found.');
  }

  assertCancellable(booking.status);
  assertCanCancel({ hasStarted: session.hasStarted });

  const wasBooked = booking.status === 'booked';
  await trx('bookings')
    .where({ id: booking.id })
    .update({ status: 'cancelled', updated_at: trx.fn.now() });
  await writeBookingEvent(trx, {
    bookingId: booking.id,
    eventType: 'status_changed',
    fromStatus: booking.status,
    toStatus: 'cancelled',
    actorUserId,
  });
  if (note) {
    await writeBookingEvent(trx, {
      bookingId: booking.id,
      eventType: 'note',
      note,
      actorUserId,
    });
  }

  let promotedIds = [];
  if (wasBooked) {
    const occupied = await countOccupiedSeats(trx, session.id);
    const freeSeats = session.capacity - occupied;
    const promoted = await promoteWaitlistFIFO(trx, {
      sessionId: session.id,
      freeSeats,
      actorUserId,
      causedByBookingId: booking.id,
    });
    promotedIds = promoted.map((row) => row.id);
  }
  return { promotedIds };
}
