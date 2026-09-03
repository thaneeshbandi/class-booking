import { Router } from 'express';
import { z } from 'zod';

import {
  OCCUPYING_STATUSES,
  countOccupiedSeats,
  countSettledBookings,
  promoteWaitlistFIFO,
  translateBookingPgError,
} from '../domain/bookingTransaction.js';
import {
  computeEndsAt,
  findSchedulingConflicts,
} from '../domain/sessionConflicts.js';
import { findActiveInstructor } from '../domain/instructors.js';
import { toCsv } from '../domain/csv.js';
import {
  expandCandidateDates,
  localTimestampString,
} from '../domain/recurringSchedule.js';
import { env } from '../config/env.js';
import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import {
  loadAuthorizedSession,
  scopeSessionsToInstructor,
} from '../middleware/sessionAccess.js';
import { idParamSchema } from '../validation/ids.js';
import { zodErrorResponse } from '../validation/respond.js';
import coInstructorsRouter from './sessionCoInstructors.js';

/**
 * Goal 3 — sessions. Staff create, view, edit and delete; an instructor may
 * only ever view a session where the database says, right now, they are the
 * primary instructor or a co-instructor (`sessionAccess.js`) — the same
 * ownership predicate this file already used for the read-only endpoints,
 * reused rather than re-expressed for create/update.
 *
 * README's goal 1 gives staff sole authority over scheduling ("studio staff
 * ... schedule sessions with a room and a primary instructor") and instructors
 * no session-editing capability of any kind, own sessions included — only
 * "see and act on" them, which is booking-lifecycle territory (goal 4), not
 * rescheduling. So every mutating route below is staff-only, with no
 * ownership carve-out for an instructor editing their own session.
 *
 * `duration_minutes` and `capacity` default from the class at creation time
 * and are then copied onto the row (006_sessions.js) — a later class-default
 * edit never reaches back to change them.
 *
 * Goal 7 also lives in this file: `POST /recurring` (staff-only bulk session
 * generation from a weekly local-time pattern) and
 * `GET /:sessionId/attendance.csv` (read-only export, same authorization
 * boundary as `GET /:sessionId/bookings`) — see each route's own comment.
 */

const router = Router();

function serializeSession(row) {
  return {
    id: row.id,
    classId: row.class_id,
    primaryInstructorId: row.primary_instructor_id,
    roomId: row.room_id,
    startsAt: row.starts_at,
    endsAt: computeEndsAt(row.starts_at, row.duration_minutes),
    durationMinutes: row.duration_minutes,
    capacity: row.capacity,
    // Only present on the list endpoint (see `GET /`) — a batch aggregate
    // computed alongside the page's own listing query, not a per-session
    // query repeated for every row. Undefined (never serialized) anywhere
    // else `serializeSession` is called.
    ...(row.booked_count !== undefined ? { bookedCount: Number(row.booked_count) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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

const listSessionsQuerySchema = z.object({
  classId: z
    .string()
    .regex(/^[1-9][0-9]*$/, 'classId must be a positive integer.')
    .optional(),
});

const sessionCreateSchema = z.object({
  classId: z.coerce.number().int().positive('classId must be a positive integer.'),
  primaryInstructorId: z.coerce
    .number()
    .int()
    .positive('primaryInstructorId must be a positive integer.'),
  roomId: z.coerce.number().int().positive('roomId must be a positive integer.'),
  startsAt: z.coerce.date({
    errorMap: () => ({ message: 'startsAt must be a valid date.' }),
  }),
  durationMinutes: z.coerce
    .number()
    .int('durationMinutes must be an integer')
    .min(1, 'durationMinutes must be at least 1')
    .optional(),
  capacity: z.coerce
    .number()
    .int('capacity must be an integer')
    .min(1, 'capacity must be at least 1')
    .optional(),
});

// Goal 7 — recurring session generation. Weekdays use JavaScript's own
// `Date.prototype.getDay()` convention (0=Sunday..6=Saturday) rather than an
// ISO weekday number, since that is the convention every other date helper
// in this codebase already reasons in (see `recurringSchedule.js`).
//
// `MAX_CANDIDATE_DATES` is an operational safety valve, not a business rule:
// nothing in the brief bounds the date range, but an unbounded range (a
// typo'd end year, say) would expand into an unbounded number of sequential
// queries inside one transaction. 500 candidates is generous for a single
// studio's weekly schedule (~9.6 years of one weekly slot) while keeping a
// worst-case request finite and fast.
const MAX_CANDIDATE_DATES = 500;

const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a 24-hour HH:MM time.');

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD.');

const recurringSessionSchema = z
  .object({
    classId: z.coerce.number().int().positive('classId must be a positive integer.'),
    primaryInstructorId: z.coerce
      .number()
      .int()
      .positive('primaryInstructorId must be a positive integer.'),
    roomId: z.coerce.number().int().positive('roomId must be a positive integer.'),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    localStartTime: localTimeSchema,
    weekdays: z
      .array(z.coerce.number().int().min(0).max(6))
      .min(1, 'weekdays must include at least one day (0=Sunday..6=Saturday).'),
    durationMinutes: z.coerce
      .number()
      .int('durationMinutes must be an integer')
      .min(1, 'durationMinutes must be at least 1')
      .optional(),
    capacity: z.coerce
      .number()
      .int('capacity must be an integer')
      .min(1, 'capacity must be at least 1')
      .optional(),
  })
  .refine((data) => data.startDate <= data.endDate, {
    message: 'endDate must be on or after startDate.',
    path: ['endDate'],
  });

const sessionUpdateSchema = z
  .object({
    primaryInstructorId: z.coerce
      .number()
      .int()
      .positive('primaryInstructorId must be a positive integer.')
      .optional(),
    roomId: z.coerce
      .number()
      .int()
      .positive('roomId must be a positive integer.')
      .optional(),
    startsAt: z.coerce
      .date({ errorMap: () => ({ message: 'startsAt must be a valid date.' }) })
      .optional(),
    durationMinutes: z.coerce
      .number()
      .int('durationMinutes must be an integer')
      .min(1, 'durationMinutes must be at least 1')
      .optional(),
    capacity: z.coerce
      .number()
      .int('capacity must be an integer')
      .min(1, 'capacity must be at least 1')
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided.',
  });

function findClass(queryable, classId) {
  return queryable('classes').where({ id: classId }).first();
}

function findRoom(queryable, roomId) {
  return queryable('rooms').where({ id: roomId }).first();
}

// Deny-by-default: every route below requires authentication, and each one
// states its own authorization policy explicitly.
router.use(authenticate);

// Collection endpoint: scoped in the query itself. Staff see every session;
// an instructor's WHERE clause is built from `scopeSessionsToInstructor`, the
// same predicate the single-session check below uses — the database never
// returns a row for a session the instructor cannot see, so there is nothing
// to filter out in JavaScript afterwards. `classId` narrows the same scoped
// query rather than bypassing it, so "opening a class shows its sessions"
// still respects instructor visibility.
router.get('/', async (req, res, next) => {
  try {
    const parsedQuery = listSessionsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json(zodErrorResponse(parsedQuery.error));
    }

    // `booked_count` is a batch aggregate (one query for the whole page),
    // not `countOccupiedSeats` repeated per row — that would be an N+1
    // query for every session in the list. The same "booked, attended, or
    // no_show" definition of occupancy the capacity-change rule already
    // uses (see `bookingTransaction.js`), so the number shown here can
    // never quietly drift from what actually blocks a capacity decrease.
    let query = db('sessions')
      .select('sessions.*')
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
      .select(db.raw('COALESCE(occupancy.booked_count, 0) AS booked_count'))
      .orderBy('starts_at', 'asc');
    if (parsedQuery.data.classId) {
      query = query.where('sessions.class_id', parsedQuery.data.classId);
    }
    if (req.user.role !== 'staff') {
      query = query.modify(scopeSessionsToInstructor, req.user.id);
    }
    const sessions = await query;
    res.json({ sessions: sessions.map(serializeSession) });
  } catch (error) {
    next(error);
  }
});

router.post('/', requireRole('staff'), async (req, res, next) => {
  try {
    const parsed = sessionCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const { classId, primaryInstructorId, roomId, startsAt } = parsed.data;

    const klass = await findClass(db, classId);
    if (!klass) return res.status(400).json({ error: 'Invalid class id.' });
    if (klass.archived_at) {
      return res
        .status(409)
        .json({ error: 'Cannot create a session for an archived class.' });
    }

    const room = await findRoom(db, roomId);
    if (!room) return res.status(400).json({ error: 'Invalid room id.' });

    const instructor = await findActiveInstructor(db, primaryInstructorId);
    if (!instructor) {
      return res.status(400).json({
        error: 'Invalid primary instructor id: must be an active instructor.',
      });
    }

    const durationMinutes =
      parsed.data.durationMinutes ?? klass.default_duration_minutes;
    const capacity = parsed.data.capacity ?? klass.default_capacity;

    // Conflict check and insert share one transaction: the approved
    // architecture's minimum bar for "transactionally safe enough" is that
    // the write is checked against, and lands as of, one consistent snapshot
    // rather than an unguarded read followed by a separate write.
    const outcome = await db.transaction(async (trx) => {
      const conflicts = await findSchedulingConflicts(trx, {
        roomId,
        instructorIds: [primaryInstructorId],
        startsAt,
        durationMinutes,
      });
      if (conflicts.length > 0) return { conflicts };

      const [inserted] = await trx('sessions')
        .insert({
          class_id: classId,
          primary_instructor_id: primaryInstructorId,
          room_id: roomId,
          starts_at: startsAt,
          duration_minutes: durationMinutes,
          capacity,
        })
        .returning('*');
      return { session: inserted };
    });

    if (outcome.conflicts) {
      return res.status(409).json({
        error: 'Session conflicts with an existing session.',
        conflicts: outcome.conflicts,
      });
    }
    res.status(201).json({ session: serializeSession(outcome.session) });
  } catch (error) {
    next(error);
  }
});

/**
 * Goal 7 — recurring session generation. Staff-only; mounted before
 * `/:sessionId` below so the literal path always wins.
 *
 * Candidate local dates are expanded in application code
 * (`expandCandidateDates`), then processed one at a time, in chronological
 * order, inside a single transaction: no `Promise.all` against the shared
 * transaction connection and no savepoints, per the approved design.
 * Each candidate's local wall-clock time is resolved to its stored instant
 * by PostgreSQL's own `AT TIME ZONE` (the same mechanism the demo seed
 * already uses), so DST correctness rests on Postgres's tzdata rather than a
 * second, hand-rolled conversion in JavaScript.
 *
 * A candidate is skipped, never fails the whole request, for three
 * machine-readable reasons: `existing_session` (an exact class/instructor/
 * room/instant match — checked first, so a repeated generation request does
 * not blindly create duplicates), `room_conflict`, and `instructor_conflict`
 * (both via the same `findSchedulingConflicts` every other session mutation
 * already uses — no duplicated conflict SQL). An unexpected database error
 * still rolls back everything generated so far in this request, since it
 * propagates out of the transaction callback like any other.
 *
 * Concurrency: like `POST /api/sessions` itself, no row lock guards this
 * check-then-insert — two concurrent recurring-generation (or single-
 * session-creation) requests targeting an overlapping slot could both pass
 * their own conflict check and both insert. That is the same accepted
 * concurrency window goal 3 already has, not a new one introduced here; see
 * `docs/architecture.md` for why an advisory lock was not added.
 */
router.post('/recurring', requireRole('staff'), async (req, res, next) => {
  try {
    const parsed = recurringSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const {
      classId,
      primaryInstructorId,
      roomId,
      startDate,
      endDate,
      localStartTime,
      weekdays,
    } = parsed.data;

    const klass = await findClass(db, classId);
    if (!klass) return res.status(400).json({ error: 'Invalid class id.' });
    if (klass.archived_at) {
      return res
        .status(409)
        .json({ error: 'Cannot generate sessions for an archived class.' });
    }

    const room = await findRoom(db, roomId);
    if (!room) return res.status(400).json({ error: 'Invalid room id.' });

    const instructor = await findActiveInstructor(db, primaryInstructorId);
    if (!instructor) {
      return res.status(400).json({
        error: 'Invalid primary instructor id: must be an active instructor.',
      });
    }

    const durationMinutes = parsed.data.durationMinutes ?? klass.default_duration_minutes;
    const capacity = parsed.data.capacity ?? klass.default_capacity;

    const candidateDates = expandCandidateDates({ startDate, endDate, weekdays });
    if (candidateDates.length === 0) {
      return res.status(400).json({
        error: 'No candidate dates fall within the given range and weekdays.',
      });
    }
    if (candidateDates.length > MAX_CANDIDATE_DATES) {
      return res.status(400).json({
        error: `This request would generate ${candidateDates.length} candidate sessions, over the limit of ${MAX_CANDIDATE_DATES}. Narrow the date range.`,
      });
    }

    const { created, skipped } = await db.transaction(async (trx) => {
      const created = [];
      const skipped = [];

      for (const date of candidateDates) {
        const { rows } = await trx.raw(
          'SELECT (?::timestamp AT TIME ZONE ?) AS starts_at',
          [localTimestampString(date, localStartTime), env.STUDIO_TIMEZONE],
        );
        const startsAt = rows[0].starts_at;

        const exactDuplicate = await trx('sessions')
          .where({
            class_id: classId,
            primary_instructor_id: primaryInstructorId,
            room_id: roomId,
            starts_at: startsAt,
          })
          .first();
        if (exactDuplicate) {
          skipped.push({
            date,
            startsAt: new Date(startsAt).toISOString(),
            reason: 'existing_session',
            conflict: { type: 'existing_session', sessionId: exactDuplicate.id },
          });
          continue;
        }

        const conflicts = await findSchedulingConflicts(trx, {
          roomId,
          instructorIds: [primaryInstructorId],
          startsAt,
          durationMinutes,
        });
        if (conflicts.length > 0) {
          const roomConflict = conflicts.find((c) => c.type === 'room');
          const reason = roomConflict ? 'room_conflict' : 'instructor_conflict';
          skipped.push({
            date,
            startsAt: new Date(startsAt).toISOString(),
            reason,
            conflict: roomConflict ?? conflicts[0],
          });
          continue;
        }

        const [inserted] = await trx('sessions')
          .insert({
            class_id: classId,
            primary_instructor_id: primaryInstructorId,
            room_id: roomId,
            starts_at: startsAt,
            duration_minutes: durationMinutes,
            capacity,
          })
          .returning('*');
        created.push({ ...serializeSession(inserted), date });
      }

      return { created, skipped };
    });

    res.json({ created, skipped });
  } catch (error) {
    next(error);
  }
});

router.get('/:sessionId', loadAuthorizedSession('sessionId'), (req, res) => {
  res.json({ session: serializeSession(req.targetSession) });
});

router.patch('/:sessionId', requireRole('staff'), async (req, res, next) => {
  try {
    const idResult = idParamSchema.safeParse(req.params.sessionId);
    if (!idResult.success) {
      return res.status(400).json({ error: 'Invalid session id.' });
    }

    const parsed = sessionUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }

    // The session row is the mutex for this whole decision, exactly as for a
    // booking mutation: everything below — the capacity floor, the settled-
    // reschedule rule, the conflict check, and any resulting promotion — is
    // read and decided against state re-read after acquiring this lock, never
    // against a value read before it.
    const outcome = await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '3s'");
      const existing = await trx('sessions').where({ id: idResult.data }).forUpdate().first();
      if (!existing) {
        return { error: { status: 404, body: { error: 'Session not found.' } } };
      }

      if (parsed.data.roomId !== undefined) {
        const room = await findRoom(trx, parsed.data.roomId);
        if (!room) {
          return { error: { status: 400, body: { error: 'Invalid room id.' } } };
        }
      }
      if (parsed.data.primaryInstructorId !== undefined) {
        const instructor = await findActiveInstructor(trx, parsed.data.primaryInstructorId);
        if (!instructor) {
          return {
            error: {
              status: 400,
              body: { error: 'Invalid primary instructor id: must be an active instructor.' },
            },
          };
        }
      }

      const roomId = parsed.data.roomId ?? existing.room_id;
      const primaryInstructorId = parsed.data.primaryInstructorId ?? existing.primary_instructor_id;
      const startsAt = parsed.data.startsAt ?? existing.starts_at;
      const durationMinutes = parsed.data.durationMinutes ?? existing.duration_minutes;
      const capacity = parsed.data.capacity ?? existing.capacity;

      const occupied = await countOccupiedSeats(trx, existing.id);
      if (capacity < occupied) {
        return {
          error: {
            status: 409,
            body: {
              error: `Cannot set capacity below the ${occupied} seat(s) already occupied.`,
            },
          },
        };
      }

      // Once a session has any attended/no_show booking, its time and
      // duration are frozen — attendance was recorded against a specific
      // real-world slot, and moving the slot afterward would falsify that
      // record. Capacity, room and instructor remain changeable.
      const settled = await countSettledBookings(trx, existing.id);
      const startsAtChanged = new Date(startsAt).getTime() !== new Date(existing.starts_at).getTime();
      const durationChanged = durationMinutes !== existing.duration_minutes;
      if (settled > 0 && (startsAtChanged || durationChanged)) {
        return {
          error: {
            status: 409,
            body: {
              error:
                'Cannot change the start time or duration of a session that already has attended or no-show bookings.',
            },
          },
        };
      }

      // Goal 5: a session's primary instructor and every co-instructor are
      // all "instructors" for conflict purposes, and the primary invariant
      // (primary != any co-instructor) must hold before this update lands —
      // both read fresh, inside this transaction, against current rows.
      const coInstructorRows = await trx('session_co_instructors')
        .where({ session_id: idResult.data })
        .select('user_id');
      const coInstructorIds = coInstructorRows.map((row) => row.user_id);

      if (
        parsed.data.primaryInstructorId !== undefined &&
        coInstructorIds.some(
          (id) => String(id) === String(parsed.data.primaryInstructorId),
        )
      ) {
        return {
          error: {
            status: 409,
            body: {
              error:
                'Cannot set the primary instructor to a user who is currently a co-instructor on this session. Remove them as a co-instructor first.',
            },
          },
        };
      }

      const conflicts = await findSchedulingConflicts(trx, {
        roomId,
        instructorIds: [primaryInstructorId, ...coInstructorIds],
        startsAt,
        durationMinutes,
        excludeSessionId: idResult.data,
      });
      if (conflicts.length > 0) return { conflicts };

      const [updated] = await trx('sessions')
        .where({ id: idResult.data })
        .update({
          room_id: roomId,
          primary_instructor_id: primaryInstructorId,
          starts_at: startsAt,
          duration_minutes: durationMinutes,
          capacity,
          updated_at: trx.fn.now(),
        })
        .returning('*');

      // A capacity increase must not leave anyone idly waitlisted while a
      // seat is free — promote in the same transaction, using the same FIFO
      // helper a booked cancellation uses, with no triggering booking.
      let promoted = [];
      if (capacity > existing.capacity) {
        promoted = await promoteWaitlistFIFO(trx, {
          sessionId: existing.id,
          freeSeats: capacity - occupied,
          actorUserId: req.user.id,
          causedByBookingId: null,
        });
      }

      return { session: updated, promoted };
    });

    if (outcome.error) {
      return res.status(outcome.error.status).json(outcome.error.body);
    }
    if (outcome.conflicts) {
      return res.status(409).json({
        error: 'Session conflicts with an existing session.',
        conflicts: outcome.conflicts,
      });
    }

    const promotedBookings = outcome.promoted.length
      ? await db('bookings')
          .join('members', 'members.id', 'bookings.member_id')
          .select(
            'bookings.*',
            'members.full_name as member_full_name',
            'members.email as member_email',
          )
          .whereIn(
            'bookings.id',
            outcome.promoted.map((booking) => booking.id),
          )
      : [];
    res.json({
      session: serializeSession(outcome.session),
      promoted: promotedBookings.map(serializeBooking),
    });
  } catch (error) {
    const translated = translateBookingPgError(error);
    if (translated) {
      return res.status(translated.status).json({ error: translated.message });
    }
    next(error);
  }
});

// Sessions are never soft-deleted: `bookings.session_id` is `ON DELETE
// RESTRICT` (008_bookings.js), so the database itself refuses to delete a
// session with any booking, cancelled or otherwise, ever attached to it. The
// explicit count check below exists only to turn that into a clear 409
// instead of a raw foreign-key-violation 500.
router.delete('/:sessionId', requireRole('staff'), async (req, res, next) => {
  try {
    const idResult = idParamSchema.safeParse(req.params.sessionId);
    if (!idResult.success) {
      return res.status(400).json({ error: 'Invalid session id.' });
    }

    // The existence check and the delete now share the session's own lock,
    // closing the race where a booking is created concurrently, between an
    // unlocked count and an unlocked delete, on a session about to be
    // removed: a concurrent booking creation's own `lockSessionForBooking`
    // blocks on this same row until this transaction ends, then either sees
    // the session gone (404, cleanly) or sees the booking this check just
    // counted.
    const outcome = await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '3s'");
      const existing = await trx('sessions').where({ id: idResult.data }).forUpdate().first();
      if (!existing) {
        return { error: { status: 404, body: { error: 'Session not found.' } } };
      }

      const [{ count }] = await trx('bookings')
        .where({ session_id: idResult.data })
        .count({ count: '*' });
      if (Number(count) > 0) {
        return {
          error: { status: 409, body: { error: 'Cannot delete a session that has bookings.' } },
        };
      }

      await trx('sessions').where({ id: idResult.data }).delete();
      return {};
    });

    if (outcome.error) {
      return res.status(outcome.error.status).json(outcome.error.body);
    }
    res.status(204).end();
  } catch (error) {
    const translated = translateBookingPgError(error);
    if (translated) {
      return res.status(translated.status).json({ error: translated.message });
    }
    next(error);
  }
});

// Booking list for one session. Authorization is the same ownership check as
// the single-session route above — a booking is only visible through a
// session the caller is authorized to see, never fetched and filtered after
// the fact.
router.get(
  '/:sessionId/bookings',
  loadAuthorizedSession('sessionId'),
  async (req, res, next) => {
    try {
      const bookings = await db('bookings')
        .join('members', 'members.id', 'bookings.member_id')
        .select(
          'bookings.*',
          'members.full_name as member_full_name',
          'members.email as member_email',
        )
        .where('bookings.session_id', req.targetSession.id)
        .orderBy('bookings.created_at', 'asc');
      res.json({ bookings: bookings.map(serializeBooking) });
    } catch (error) {
      next(error);
    }
  },
);

// Goal 7 — attendance CSV export. Same authorization boundary as
// `/:sessionId/bookings` above (reuses `loadAuthorizedSession`): staff, the
// session's primary instructor, or a co-instructor may export it; anyone
// else is denied by the same database-re-read ownership check every other
// session-scoped route in this file already uses.
//
// Read-only: the only queries this route runs are SELECTs. `bookings.status`
// is read directly rather than replayed from `booking_events` — the
// immutable history exists for auditability, not as the authoritative
// current-status source, and every one of the five final statuses (booked,
// waitlisted, cancelled, attended, no_show) is exported, not only settled
// ones.
router.get(
  '/:sessionId/attendance.csv',
  loadAuthorizedSession('sessionId'),
  async (req, res, next) => {
    try {
      const bookings = await db('bookings')
        .join('members', 'members.id', 'bookings.member_id')
        .select(
          'bookings.id',
          'bookings.status',
          'bookings.created_at',
          'members.full_name',
          'members.email',
        )
        .where('bookings.session_id', req.targetSession.id)
        // Alphabetical by member is the useful order for a printed sign-in/
        // attendance sheet; the booking id tiebreaks deterministically.
        .orderBy('members.full_name', 'asc')
        .orderBy('bookings.id', 'asc');

      const csv = toCsv(
        ['Booking ID', 'Member Name', 'Member Email', 'Status', 'Booked At'],
        // `created_at` arrives from `pg` as a JS `Date`; `String(date)` would
        // render it in the server process's own local timezone (never a
        // studio-meaningful one) rather than a stable, unambiguous instant —
        // `toISOString()` avoids that, matching every timestamp already
        // returned elsewhere in this API's JSON responses.
        bookings.map((b) => [b.id, b.full_name, b.email, b.status, b.created_at.toISOString()]),
      );

      // Filename built only from the session id and its own starts_at date —
      // never from free-text fields (a class title, a member name) that a
      // user could have chosen to include a path separator or control
      // character in.
      const dateStr = new Date(req.targetSession.starts_at).toISOString().slice(0, 10);
      const filename = `attendance-session-${req.targetSession.id}-${dateStr}.csv`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      next(error);
    }
  },
);

// Goal 5 — co-instructor management, nested under the session it belongs to.
// Mounted after `authenticate` above, so every route in it already has
// `req.user`; each route within states its own authorization on top of that,
// same as every other route in this file.
router.use('/:sessionId/co-instructors', coInstructorsRouter);

export default router;
