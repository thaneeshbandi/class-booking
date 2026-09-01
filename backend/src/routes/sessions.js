import { Router } from 'express';

import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import {
  loadAuthorizedSession,
  scopeSessionsToInstructor,
} from '../middleware/sessionAccess.js';

/**
 * Minimal, read-only session endpoints.
 *
 * These exist to give the authorization foundation something real to run
 * against — deny-by-default access, server-side instructor scoping in SQL,
 * and resource-level ownership — not to deliver goal 3 (session CRUD) or
 * goal 6 (search/filter/sort/pagination). There is deliberately no create,
 * edit or delete here, and no search, filtering, sorting or pagination on the
 * list: those are their own goals and arrive with them.
 */

const router = Router();

function serializeSession(row) {
  return {
    id: row.id,
    classId: row.class_id,
    primaryInstructorId: row.primary_instructor_id,
    roomId: row.room_id,
    startsAt: row.starts_at,
    durationMinutes: row.duration_minutes,
    capacity: row.capacity,
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

// Deny-by-default: every route below requires authentication, and each one
// states its own authorization policy explicitly.
router.use(authenticate);

// Collection endpoint: scoped in the query itself. Staff see every session;
// an instructor's WHERE clause is built from `scopeSessionsToInstructor`, the
// same predicate the single-session check below uses — the database never
// returns a row for a session the instructor cannot see, so there is nothing
// to filter out in JavaScript afterwards.
router.get('/', async (req, res, next) => {
  try {
    let query = db('sessions').select('*').orderBy('starts_at', 'asc');
    if (req.user.role !== 'staff') {
      query = query.modify(scopeSessionsToInstructor, req.user.id);
    }
    const sessions = await query;
    res.json({ sessions: sessions.map(serializeSession) });
  } catch (error) {
    next(error);
  }
});

router.get('/:sessionId', loadAuthorizedSession('sessionId'), (req, res) => {
  res.json({ session: serializeSession(req.targetSession) });
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
