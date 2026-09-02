import { Router } from 'express';
import { z } from 'zod';

import { BookingError } from '../domain/bookingErrors.js';
import { assertCancellable, assertSettleable } from '../domain/bookingTransitions.js';
import { assertCanCancel, assertCanCreate, assertCanSettle } from '../domain/bookingTiming.js';
import { isMembershipExpired } from '../domain/membership.js';
import {
  countOccupiedSeats,
  loadBookingForUpdate,
  lockSessionForBooking,
  promoteWaitlistFIFO,
  translateBookingPgError,
  writeBookingEvent,
} from '../domain/bookingTransaction.js';
import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { loadAuthorizedBooking, scopeSessionsToInstructor } from '../middleware/sessionAccess.js';
import { idParamSchema } from '../validation/ids.js';
import { zodErrorResponse } from '../validation/respond.js';

/**
 * Goal 4 — the booking lifecycle: creation, cancellation with FIFO waitlist
 * promotion, settlement, and read access to a booking's immutable history.
 *
 * There is deliberately no `PATCH /:bookingId { status }`. Every mutation is
 * an explicit intent endpoint (create / cancel / settle) so the set of
 * reachable status transitions is exactly what `bookingTransitions.js`
 * encodes — never an arbitrary status supplied by the client.
 *
 * Every mutation follows the same lock protocol: `lockSessionForBooking`
 * acquires the session-row mutex and reads `hasStarted`/`hasFinished`/
 * `studioToday` from Postgres in one round trip; only after that is a
 * booking row itself read `FOR UPDATE` (lock order: session, then booking —
 * never reversed), and only after *that* does the route decide anything.
 */

const router = Router();

function serializeBooking(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    memberId: row.member_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    member: {
      fullName: row.member_full_name,
      email: row.member_email,
    },
  };
}

function serializeEvent(row) {
  return {
    id: row.id,
    eventType: row.event_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    actorUserId: row.actor_user_id,
    isAutomatic: row.is_automatic,
    causedByBookingId: row.caused_by_booking_id,
    occurredAt: row.occurred_at,
  };
}

/** Re-reads a booking joined with its member, for response serialization —
 * always run after the transaction that changed it has committed. */
function bookingWithMemberQuery() {
  return db('bookings')
    .join('members', 'members.id', 'bookings.member_id')
    .select('bookings.*', 'members.full_name as member_full_name', 'members.email as member_email');
}

function fetchBookingWithMember(bookingId) {
  return bookingWithMemberQuery().where('bookings.id', bookingId).first();
}

async function fetchBookingsWithMember(bookingIds) {
  if (bookingIds.length === 0) return [];
  const rows = await bookingWithMemberQuery().whereIn('bookings.id', bookingIds);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  // Preserve the caller's (FIFO) order rather than whatever order the IN
  // clause happens to return.
  return bookingIds.map((id) => byId.get(String(id)));
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    // Joins `sessions` itself (unlike `bookingWithMemberQuery`, used
    // elsewhere only to re-fetch a single already-authorized booking) because
    // `scopeSessionsToInstructor` below is a predicate over `sessions`
    // columns.
    let query = db('bookings')
      .join('sessions', 'sessions.id', 'bookings.session_id')
      .join('members', 'members.id', 'bookings.member_id')
      .select(
        'bookings.*',
        'members.full_name as member_full_name',
        'members.email as member_email',
      )
      .orderBy('bookings.created_at', 'asc');

    // Scoped in the query itself, with the same predicate the session
    // endpoints use: an instructor's WHERE clause only ever matches bookings
    // whose session they are the primary or a co-instructor for, so no row
    // for another instructor's session is ever fetched, let alone filtered
    // out afterwards.
    if (req.user.role !== 'staff') {
      query = query.modify(scopeSessionsToInstructor, req.user.id);
    }

    const bookings = await query;
    res.json({ bookings: bookings.map(serializeBooking) });
  } catch (error) {
    next(error);
  }
});

const createBookingSchema = z.object({
  sessionId: idParamSchema,
  memberId: idParamSchema,
});

router.post('/', authenticate, requireRole('staff'), async (req, res, next) => {
  try {
    const parsed = createBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const { sessionId, memberId } = parsed.data;

    const bookingId = await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '3s'");
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
        throw new BookingError(
          409,
          `This member's membership expired on ${member.membership_expires_on}.`,
        );
      }

      const existingActive = await trx('bookings')
        .where({ session_id: sessionId, member_id: memberId })
        .whereIn('status', ['booked', 'waitlisted'])
        .first();
      if (existingActive) {
        throw new BookingError(
          409,
          'This member already has an active booking for this session.',
        );
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
        actorUserId: req.user.id,
      });
      return booking.id;
    });

    const booking = await fetchBookingWithMember(bookingId);
    res.status(201).json({ booking: serializeBooking(booking) });
  } catch (error) {
    if (error instanceof BookingError) {
      return res.status(error.status).json({ error: error.message });
    }
    const translated = translateBookingPgError(error);
    if (translated) {
      return res.status(translated.status).json({ error: translated.message });
    }
    next(error);
  }
});

const cancelBookingSchema = z.object({
  note: z.string().trim().min(1).optional(),
});

router.post('/:bookingId/cancel', authenticate, requireRole('staff'), async (req, res, next) => {
  try {
    const idResult = idParamSchema.safeParse(req.params.bookingId);
    if (!idResult.success) {
      return res.status(400).json({ error: 'Invalid booking id.' });
    }
    const parsed = cancelBookingSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const bookingId = idResult.data;

    // An unlocked peek only to discover which session to lock; every
    // decision below re-reads the booking under that session's lock.
    const peek = await db('bookings').where({ id: bookingId }).first('session_id');
    if (!peek) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const { promotedIds } = await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '3s'");
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
        actorUserId: req.user.id,
      });
      if (parsed.data.note) {
        await writeBookingEvent(trx, {
          bookingId: booking.id,
          eventType: 'note',
          note: parsed.data.note,
          actorUserId: req.user.id,
        });
      }

      let promoted = [];
      if (wasBooked) {
        const occupied = await countOccupiedSeats(trx, session.id);
        const freeSeats = session.capacity - occupied;
        promoted = await promoteWaitlistFIFO(trx, {
          sessionId: session.id,
          freeSeats,
          actorUserId: req.user.id,
          causedByBookingId: booking.id,
        });
      }
      return { promotedIds: promoted.map((row) => row.id) };
    });

    const [booking, promoted] = await Promise.all([
      fetchBookingWithMember(bookingId),
      fetchBookingsWithMember(promotedIds),
    ]);
    res.json({
      booking: serializeBooking(booking),
      promoted: promoted.map(serializeBooking),
    });
  } catch (error) {
    if (error instanceof BookingError) {
      return res.status(error.status).json({ error: error.message });
    }
    const translated = translateBookingPgError(error);
    if (translated) {
      return res.status(translated.status).json({ error: translated.message });
    }
    next(error);
  }
});

const settleBookingSchema = z.object({
  status: z.enum(['attended', 'no_show']),
  note: z.string().trim().min(1).optional(),
});

router.post('/:bookingId/settle', authenticate, async (req, res, next) => {
  try {
    const idResult = idParamSchema.safeParse(req.params.bookingId);
    if (!idResult.success) {
      return res.status(400).json({ error: 'Invalid booking id.' });
    }
    const parsed = settleBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const bookingId = idResult.data;

    const peek = await db('bookings').where({ id: bookingId }).first('session_id');
    if (!peek) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '3s'");
      const session = await lockSessionForBooking(trx, peek.session_id);

      // Re-checked here, inside the transaction, against the session row
      // just locked — never against the client-supplied session id, and
      // never against a value read before this point.
      if (req.user.role !== 'staff') {
        const isPrimary = String(session.primaryInstructorId) === String(req.user.id);
        const isCoInstructor = isPrimary
          ? true
          : await trx('session_co_instructors')
              .where({ session_id: session.id, user_id: req.user.id })
              .first();
        if (!isPrimary && !isCoInstructor) {
          throw new BookingError(403, 'Forbidden.');
        }
      }

      const booking = await loadBookingForUpdate(trx, bookingId);
      if (!booking) {
        throw new BookingError(404, 'Booking not found.');
      }

      assertSettleable(booking.status, parsed.data.status);
      assertCanSettle({ hasFinished: session.hasFinished });

      await trx('bookings')
        .where({ id: booking.id })
        .update({ status: parsed.data.status, updated_at: trx.fn.now() });
      await writeBookingEvent(trx, {
        bookingId: booking.id,
        eventType: 'status_changed',
        fromStatus: booking.status,
        toStatus: parsed.data.status,
        actorUserId: req.user.id,
      });
      if (parsed.data.note) {
        await writeBookingEvent(trx, {
          bookingId: booking.id,
          eventType: 'note',
          note: parsed.data.note,
          actorUserId: req.user.id,
        });
      }
    });

    const booking = await fetchBookingWithMember(bookingId);
    res.json({ booking: serializeBooking(booking) });
  } catch (error) {
    if (error instanceof BookingError) {
      return res.status(error.status).json({ error: error.message });
    }
    const translated = translateBookingPgError(error);
    if (translated) {
      return res.status(translated.status).json({ error: translated.message });
    }
    next(error);
  }
});

router.get('/:bookingId', authenticate, async (req, res, next) => {
  try {
    const idResult = idParamSchema.safeParse(req.params.bookingId);
    if (!idResult.success) {
      return res.status(400).json({ error: 'Invalid booking id.' });
    }
    const bookingId = idResult.data;

    const { error } = await loadAuthorizedBooking(db, bookingId, req.user);
    if (error) {
      return res.status(error).json({ error: error === 404 ? 'Booking not found.' : 'Forbidden.' });
    }

    const [booking, events] = await Promise.all([
      fetchBookingWithMember(bookingId),
      db('booking_events')
        .where({ booking_id: bookingId })
        .orderBy('occurred_at', 'asc')
        .orderBy('id', 'asc'),
    ]);

    res.json({ booking: serializeBooking(booking), events: events.map(serializeEvent) });
  } catch (error) {
    next(error);
  }
});

export default router;
