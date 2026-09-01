import { Router } from 'express';
import { z } from 'zod';

import {
  computeEndsAt,
  findSchedulingConflicts,
} from '../domain/sessionConflicts.js';
import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import {
  loadAuthorizedSession,
  scopeSessionsToInstructor,
} from '../middleware/sessionAccess.js';
import { idParamSchema } from '../validation/ids.js';
import { zodErrorResponse } from '../validation/respond.js';

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

/** An instructor may only be assigned as primary if they are, right now, an
 * active account with the instructor role — never staff, never a
 * deactivated login. */
function findActiveInstructor(queryable, instructorId) {
  return queryable('users')
    .where({ id: instructorId, role: 'instructor', is_active: true })
    .first();
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

    let query = db('sessions').select('*').orderBy('starts_at', 'asc');
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
        instructorId: primaryInstructorId,
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

    const existing = await db('sessions').where({ id: idResult.data }).first();
    if (!existing) return res.status(404).json({ error: 'Session not found.' });

    if (parsed.data.roomId !== undefined) {
      const room = await findRoom(db, parsed.data.roomId);
      if (!room) return res.status(400).json({ error: 'Invalid room id.' });
    }
    if (parsed.data.primaryInstructorId !== undefined) {
      const instructor = await findActiveInstructor(
        db,
        parsed.data.primaryInstructorId,
      );
      if (!instructor) {
        return res.status(400).json({
          error:
            'Invalid primary instructor id: must be an active instructor.',
        });
      }
    }

    const roomId = parsed.data.roomId ?? existing.room_id;
    const primaryInstructorId =
      parsed.data.primaryInstructorId ?? existing.primary_instructor_id;
    const startsAt = parsed.data.startsAt ?? existing.starts_at;
    const durationMinutes =
      parsed.data.durationMinutes ?? existing.duration_minutes;
    const capacity = parsed.data.capacity ?? existing.capacity;

    const outcome = await db.transaction(async (trx) => {
      const conflicts = await findSchedulingConflicts(trx, {
        roomId,
        instructorId: primaryInstructorId,
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
      return { session: updated };
    });

    if (outcome.conflicts) {
      return res.status(409).json({
        error: 'Session conflicts with an existing session.',
        conflicts: outcome.conflicts,
      });
    }
    res.json({ session: serializeSession(outcome.session) });
  } catch (error) {
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

    const existing = await db('sessions').where({ id: idResult.data }).first();
    if (!existing) return res.status(404).json({ error: 'Session not found.' });

    const [{ count }] = await db('bookings')
      .where({ session_id: idResult.data })
      .count({ count: '*' });
    if (Number(count) > 0) {
      return res
        .status(409)
        .json({ error: 'Cannot delete a session that has bookings.' });
    }

    await db('sessions').where({ id: idResult.data }).delete();
    res.status(204).end();
  } catch (error) {
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

export default router;
