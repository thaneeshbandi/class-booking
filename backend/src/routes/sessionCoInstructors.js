import { Router } from 'express';
import { z } from 'zod';

import { findActiveInstructor } from '../domain/instructors.js';
import { computeEndsAt, findInstructorConflict } from '../domain/sessionConflicts.js';
import { db } from '../db/knex.js';
import { requireRole } from '../middleware/authorize.js';
import { loadAuthorizedSession } from '../middleware/sessionAccess.js';
import { idParamSchema } from '../validation/ids.js';
import { zodErrorResponse } from '../validation/respond.js';

/**
 * Goal 5 — co-instructors, nested under `/api/sessions/:sessionId`
 * (`mergeParams: true` so `req.params.sessionId` reaches every route here;
 * `sessions.js` mounts this after its own `router.use(authenticate)`).
 *
 * Listing reuses `loadAuthorizedSession` — the one definition of "this
 * session belongs to this instructor" — so a session's own primary/
 * co-instructors can see who else teaches it exactly like they can already
 * see the session itself and its bookings, while an unrelated instructor is
 * denied the same way. Adding and removing are staff-only per the brief
 * ("all co-instructor management is STAFF-ONLY"), enforced with
 * `requireRole('staff')` before anything else runs.
 *
 * Co-instructors participate in scheduling conflicts exactly like the
 * primary instructor (007_session_co_instructors.js), so adding one reuses
 * `findInstructorConflict` — the same conflict primitive `sessionConflicts.js`
 * already uses for session create/update — against the session's own
 * `starts_at` + `duration_minutes` interval.
 */

const router = Router({ mergeParams: true });

function serializeCoInstructor(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    addedAt: row.added_at,
  };
}

const addCoInstructorSchema = z.object({
  instructorId: z.coerce
    .number()
    .int()
    .positive('instructorId must be a positive integer.'),
});

router.get('/', loadAuthorizedSession('sessionId'), async (req, res, next) => {
  try {
    const rows = await db('session_co_instructors')
      .join('users', 'users.id', 'session_co_instructors.user_id')
      .select(
        'users.id',
        'users.full_name',
        'users.email',
        'session_co_instructors.added_at',
      )
      .where('session_co_instructors.session_id', req.targetSession.id)
      .orderBy('session_co_instructors.added_at', 'asc');
    res.json({ coInstructors: rows.map(serializeCoInstructor) });
  } catch (error) {
    next(error);
  }
});

router.post('/', requireRole('staff'), async (req, res, next) => {
  try {
    const sessionIdResult = idParamSchema.safeParse(req.params.sessionId);
    if (!sessionIdResult.success) {
      return res.status(400).json({ error: 'Invalid session id.' });
    }

    const parsed = addCoInstructorSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const { instructorId } = parsed.data;

    // One transaction: lock the session row, validate the instructor and the
    // primary/co-instructor invariant, check the scheduling conflict, and
    // insert — all against one consistent snapshot, per the brief.
    const outcome = await db.transaction(async (trx) => {
      const session = await trx('sessions')
        .where({ id: sessionIdResult.data })
        .forUpdate()
        .first();
      if (!session) {
        return { error: { status: 404, body: { error: 'Session not found.' } } };
      }

      const instructor = await findActiveInstructor(trx, instructorId);
      if (!instructor) {
        return {
          error: {
            status: 400,
            body: { error: 'Invalid instructor id: must be an active instructor.' },
          },
        };
      }

      if (String(instructor.id) === String(session.primary_instructor_id)) {
        return {
          error: {
            status: 409,
            body: {
              error: 'This user is already the primary instructor for this session.',
            },
          },
        };
      }

      const existing = await trx('session_co_instructors')
        .where({ session_id: session.id, user_id: instructor.id })
        .first();
      if (existing) {
        return {
          error: {
            status: 409,
            body: { error: 'This instructor is already a co-instructor on this session.' },
          },
        };
      }

      const conflict = await findInstructorConflict(trx, {
        instructorId: instructor.id,
        startsAt: session.starts_at,
        endsAt: computeEndsAt(session.starts_at, session.duration_minutes),
        excludeSessionId: session.id,
      });
      if (conflict) {
        return {
          error: {
            status: 409,
            body: {
              error: 'This instructor conflicts with an existing session.',
              conflict: {
                type: 'instructor',
                sessionId: conflict.id,
                startsAt: conflict.starts_at,
                endsAt: computeEndsAt(conflict.starts_at, conflict.duration_minutes),
              },
            },
          },
        };
      }

      const [inserted] = await trx('session_co_instructors')
        .insert({
          session_id: session.id,
          user_id: instructor.id,
          session_primary_instructor_id: session.primary_instructor_id,
        })
        .returning('*');

      return {
        coInstructor: {
          id: instructor.id,
          full_name: instructor.full_name,
          email: instructor.email,
          added_at: inserted.added_at,
        },
      };
    });

    if (outcome.error) {
      return res.status(outcome.error.status).json(outcome.error.body);
    }
    res.status(201).json({ coInstructor: serializeCoInstructor(outcome.coInstructor) });
  } catch (error) {
    next(error);
  }
});

// Removal cannot create a conflict — it only narrows who is scheduled — so no
// conflict check runs here, and a plain transactionless delete is enough.
router.delete('/:instructorId', requireRole('staff'), async (req, res, next) => {
  try {
    const sessionIdResult = idParamSchema.safeParse(req.params.sessionId);
    if (!sessionIdResult.success) {
      return res.status(400).json({ error: 'Invalid session id.' });
    }
    const instructorIdResult = idParamSchema.safeParse(req.params.instructorId);
    if (!instructorIdResult.success) {
      return res.status(400).json({ error: 'Invalid instructor id.' });
    }

    const session = await db('sessions').where({ id: sessionIdResult.data }).first();
    if (!session) return res.status(404).json({ error: 'Session not found.' });

    const deletedCount = await db('session_co_instructors')
      .where({ session_id: sessionIdResult.data, user_id: instructorIdResult.data })
      .delete();
    if (deletedCount === 0) {
      return res.status(404).json({ error: 'Co-instructor assignment not found.' });
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
