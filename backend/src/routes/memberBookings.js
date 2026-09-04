import { Router } from 'express';
import { z } from 'zod';

import { BookingError } from '../domain/bookingErrors.js';
import {
  OCCUPYING_STATUSES,
  cancelBookingInTransaction,
  createBookingInTransaction,
  translateBookingPgError,
} from '../domain/bookingTransaction.js';
import { BOOKING_STATUSES } from './bookings.js';
import { env } from '../config/env.js';
import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { idParamSchema } from '../validation/ids.js';
import { zodErrorResponse } from '../validation/respond.js';

/** A booking that currently holds a live claim on its session — the same
 * pair `createBookingInTransaction`'s own duplicate-active-booking check
 * uses. Used here to decide "does the caller already have a booking on this
 * session" (`GET /sessions`'s `myBooking` field and the `mine` availability
 * filter), never to decide occupancy — that stays `OCCUPYING_STATUSES`. */
const ACTIVE_BOOKING_STATUSES = ['booked', 'waitlisted'];

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

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD.');

const listMemberSessionsQuerySchema = z.object({
  classId: idParamSchema.optional(),
  // Both ends optional and independent: `dateFrom` alone means "from this
  // day on", `dateTo` alone means "up to and including this day", both
  // together means a range, matching how a From/To pair of date pickers
  // naturally behaves.
  dateFrom: isoDateSchema.optional(),
  dateTo: isoDateSchema.optional(),
  availability: z.enum(['available', 'full', 'mine']).optional(),
});

/**
 * Browse upcoming sessions — every field a member's own booking state
 * (`myBooking`) needs to be derived from, in this single response. This is
 * the fix for a real frontend bug: without this field, the browsing page
 * had no authoritative source for "have I already booked this session" at
 * all, and fell back to a client-only "I just clicked this one" flag that a
 * second booking silently overwrote. `myBooking` is `null` unless the
 * caller currently holds a live (`booked`/`waitlisted`) claim on that
 * session — computed by joining `bookings` scoped to the caller's own
 * member id, the same `requireOwnMember`-derived id every other route here
 * already trusts, never anything client-supplied.
 */
router.get('/sessions', async (req, res, next) => {
  try {
    const parsed = listMemberSessionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const { classId, dateFrom, dateTo, availability } = parsed.data;

    const member = await requireOwnMember(req, res);
    if (!member) return;

    let query = db('sessions')
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
      .leftJoin(
        db('bookings')
          .select('id', 'session_id', 'status')
          .where('member_id', member.id)
          .whereIn('status', ACTIVE_BOOKING_STATUSES)
          .as('my_booking'),
        'my_booking.session_id',
        'sessions.id',
      )
      .where('sessions.starts_at', '>=', db.fn.now())
      .whereNull('classes.archived_at')
      .whereNull('rooms.archived_at');

    if (classId) {
      query = query.where('sessions.class_id', classId);
    }
    if (dateFrom) {
      // Studio-local midnight on `dateFrom`, converted to the correct
      // instant by Postgres's own `AT TIME ZONE` — the same mechanism
      // `recurringSchedule.js#localTimestampString` and the seed script use
      // for the identical local-wall-clock-to-instant problem, never a
      // second, hand-rolled timezone conversion in JavaScript.
      query = query.where(
        'sessions.starts_at',
        '>=',
        db.raw('(?::date)::timestamp AT TIME ZONE ?', [dateFrom, env.STUDIO_TIMEZONE]),
      );
    }
    if (dateTo) {
      // Strictly before studio-local midnight the day *after* `dateTo` —
      // an exclusive upper bound, so `dateTo` itself is fully included
      // regardless of what local time a session that day starts at.
      query = query.where(
        'sessions.starts_at',
        '<',
        db.raw('(?::date + 1)::timestamp AT TIME ZONE ?', [dateTo, env.STUDIO_TIMEZONE]),
      );
    }
    if (availability === 'mine') {
      query = query.whereNotNull('my_booking.id');
    } else if (availability === 'available') {
      query = query.whereRaw('COALESCE(occupancy.booked_count, 0) < sessions.capacity');
    } else if (availability === 'full') {
      query = query.whereRaw('COALESCE(occupancy.booked_count, 0) >= sessions.capacity');
    }

    const rows = await query
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
        'my_booking.id as my_booking_id',
        'my_booking.status as my_booking_status',
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
          myBooking: row.my_booking_id ? { id: row.my_booking_id, status: row.my_booking_status } : null,
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

const listMemberBookingsQuerySchema = z.object({
  status: z.enum(BOOKING_STATUSES).optional(),
  classId: idParamSchema.optional(),
  dateFrom: isoDateSchema.optional(),
  dateTo: isoDateSchema.optional(),
});

router.get('/bookings', async (req, res, next) => {
  try {
    const parsed = listMemberBookingsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const { status, classId, dateFrom, dateTo } = parsed.data;

    const member = await requireOwnMember(req, res);
    if (!member) return;

    // Ownership (`bookings.member_id = member.id`) is applied before any of
    // the optional filters below and every one of them is ANDed onto it —
    // none can widen the result past the caller's own bookings, only narrow
    // it further.
    let query = memberBookingQuery().where('bookings.member_id', member.id);
    if (status) {
      query = query.where('bookings.status', status);
    }
    if (classId) {
      query = query.where('classes.id', classId);
    }
    if (dateFrom) {
      // Studio-local midnight on `dateFrom`, resolved to the correct instant
      // by Postgres's own `AT TIME ZONE` — the same mechanism
      // `routes/sessions.js` and `routes/memberBookings.js`'s own
      // `GET /sessions` date filters already use.
      query = query.where(
        'sessions.starts_at',
        '>=',
        db.raw('(?::date)::timestamp AT TIME ZONE ?', [dateFrom, env.STUDIO_TIMEZONE]),
      );
    }
    if (dateTo) {
      query = query.where(
        'sessions.starts_at',
        '<',
        db.raw('(?::date + 1)::timestamp AT TIME ZONE ?', [dateTo, env.STUDIO_TIMEZONE]),
      );
    }

    const rows = await query.orderBy('sessions.starts_at', 'desc');
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
