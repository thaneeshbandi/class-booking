import { Router } from 'express';
import { z } from 'zod';

import { BookingError } from '../domain/bookingErrors.js';
import {
  OCCUPYING_STATUSES,
  cancelBookingInTransaction,
  createBookingInTransaction,
  translateBookingPgError,
} from '../domain/bookingTransaction.js';
import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { idParamSchema } from '../validation/ids.js';
import { zodErrorResponse } from '../validation/respond.js';

/**
 * The member portal's own booking surface — browsing, creating, listing and
 * cancelling bookings for the authenticated member's *own* record only.
 *
 * Every route here is `requireRole('member')`: a staff or instructor account
 * has no member record of its own to book with, and this is not a general
 * "book on someone's behalf" API (that is `POST /api/bookings`, staff-only,
 * `memberId` taken from the body). `memberId` is never accepted from the
 * client here — it is always looked up from `members.user_id = req.user.id`
 * (see `requireOwnMember`) — so there is no request shape that could book or
 * cancel on behalf of another member.
 *
 * Creation and cancellation both call straight into
 * `domain/bookingTransaction.js`'s `createBookingInTransaction` /
 * `cancelBookingInTransaction` — the exact same functions
 * `routes/bookings.js` (the staff booking routes) call. Capacity, waitlist
 * FIFO promotion, membership-expiry rejection and the cancellable-status
 * rules therefore cannot diverge between a staff-made booking and a
 * member's own — there is only one implementation of any of them.
 */

const router = Router();

router.use(authenticate, requireRole('member'));

/** The member row this account claimed or was given at signup — see
 * `domain/memberLinking.js`. Every signup either links to or creates
 * exactly one, so a missing row here means the link was broken some other
 * way (never expected in normal operation); reported as 404 rather than a
 * 500, since it is a well-formed "there is nothing to show" outcome. */
async function requireOwnMember(req, res) {
  const member = await db('members').where({ user_id: req.user.id }).first();
  if (!member) {
    res.status(404).json({ error: 'No member record is linked to this account.' });
    return null;
  }
  return member;
}

router.get('/sessions', async (_req, res, next) => {
  try {
    const rows = await db('sessions')
      .join('classes', 'classes.id', 'sessions.class_id')
      .join('rooms', 'rooms.id', 'sessions.room_id')
      .join('users', 'users.id', 'sessions.primary_instructor_id')
      .leftJoin(
        db('bookings')
          .select('session_id')
          .count({ booked_count: '*' })
          .whereIn('status', OCCUPYING_STATUSES)
          .groupBy('session_id')
          .as('occupancy'),
        'occupancy.session_id',
        'sessions.id',
      )
      .where('sessions.starts_at', '>=', db.fn.now())
      .whereNull('classes.archived_at')
      .whereNull('rooms.archived_at')
      .select(
        'sessions.id',
        'sessions.starts_at',
        'sessions.duration_minutes',
        'sessions.capacity',
        'classes.id as class_id',
        'classes.title as class_title',
        'classes.discipline as class_discipline',
        'rooms.name as room_name',
        'users.full_name as instructor_name',
        db.raw('COALESCE(occupancy.booked_count, 0) AS booked_count'),
      )
      .orderBy('sessions.starts_at', 'asc');

    res.json({
      sessions: rows.map((row) => {
        const bookedCount = Number(row.booked_count);
        return {
          id: row.id,
          startsAt: row.starts_at,
          durationMinutes: row.duration_minutes,
          capacity: row.capacity,
          bookedCount,
          isFull: bookedCount >= row.capacity,
          class: { id: row.class_id, title: row.class_title, discipline: row.class_discipline },
          room: { name: row.room_name },
          instructor: { fullName: row.instructor_name },
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

function serializeMemberBooking(row) {
  return {
    id: row.id,
    status: row.status,
    bookedAt: row.booked_at,
    session: {
      id: row.session_id,
      startsAt: row.starts_at,
      durationMinutes: row.duration_minutes,
    },
    class: { id: row.class_id, title: row.class_title },
  };
}

function memberBookingQuery() {
  return db('bookings')
    .join('sessions', 'sessions.id', 'bookings.session_id')
    .join('classes', 'classes.id', 'sessions.class_id')
    .select(
      'bookings.id',
      'bookings.status',
      'bookings.created_at as booked_at',
      'sessions.id as session_id',
      'sessions.starts_at',
      'sessions.duration_minutes',
      'classes.id as class_id',
      'classes.title as class_title',
    );
}

router.get('/bookings', async (req, res, next) => {
  try {
    const member = await requireOwnMember(req, res);
    if (!member) return;

    const rows = await memberBookingQuery()
      .where('bookings.member_id', member.id)
      .orderBy('sessions.starts_at', 'desc');
    // `membership` rides along on this response rather than getting its own
    // endpoint: the member row is already loaded here (`requireOwnMember`),
    // and the member home page is the only place this value is shown
    // alongside "your upcoming bookings" — the same data this route already
    // fetches for.
    res.json({
      bookings: rows.map(serializeMemberBooking),
      membership: { expiresOn: member.membership_expires_on },
    });
  } catch (error) {
    next(error);
  }
});

const createMemberBookingSchema = z.object({ sessionId: idParamSchema });

router.post('/bookings', async (req, res, next) => {
  try {
    const parsed = createMemberBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const member = await requireOwnMember(req, res);
    if (!member) return;

    const bookingId = await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '3s'");
      return createBookingInTransaction(trx, {
        sessionId: parsed.data.sessionId,
        memberId: member.id,
        actorUserId: req.user.id,
      });
    });

    const row = await memberBookingQuery().where('bookings.id', bookingId).first();
    res.status(201).json({ booking: serializeMemberBooking(row) });
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

router.post('/bookings/:bookingId/cancel', async (req, res, next) => {
  try {
    const idResult = idParamSchema.safeParse(req.params.bookingId);
    if (!idResult.success) {
      return res.status(400).json({ error: 'Invalid booking id.' });
    }
    const member = await requireOwnMember(req, res);
    if (!member) return;

    // `member_id` is immutable once a booking is created (no route ever
    // updates it — see `bookings.js`), so this unlocked ownership read
    // cannot race against anything that would change the answer. A booking
    // that exists but belongs to someone else is reported identically to
    // one that doesn't exist — never confirming another member's booking.
    const bookingId = idResult.data;
    const peek = await db('bookings').where({ id: bookingId }).first('member_id');
    if (!peek || String(peek.member_id) !== String(member.id)) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '3s'");
      await cancelBookingInTransaction(trx, { bookingId, actorUserId: req.user.id });
    });

    const row = await memberBookingQuery().where('bookings.id', bookingId).first();
    res.json({ booking: serializeMemberBooking(row) });
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

export default router;
