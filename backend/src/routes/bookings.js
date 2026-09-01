import { Router } from 'express';

import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { scopeSessionsToInstructor } from '../middleware/sessionAccess.js';

/**
 * A single, minimal, read-only endpoint: every booking across every session
 * the caller can see. This exists only to give goal 6's "one list shows
 * bookings across every session the viewer can see" collection-authorization
 * requirement something real to run against — search, filtering beyond
 * ownership, sorting, pagination and the total-match count are goal 6 and are
 * not implemented here.
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

router.get('/', authenticate, async (req, res, next) => {
  try {
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

export default router;
