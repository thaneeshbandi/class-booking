import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { zodErrorResponse } from '../validation/respond.js';

/**
 * Read-only, staff-only user listing — added for the frontend milestone,
 * not part of the original ten goals: the session-create, recurring-
 * generation, and add-co-instructor forms all need to offer a real picker
 * of active instructors, and nothing in the API surface before this
 * exposed one (`findActiveInstructor` in `domain/instructors.js` only ever
 * validated a single client-supplied id, never listed candidates). Without
 * this, staff would have to type a numeric user id blind. Staff-only: an
 * instructor has no session-scheduling or co-instructor-management
 * capability (goal 3, goal 5), so there is no legitimate reason for one to
 * browse the studio's account list. See `docs/decisions.md`.
 *
 * Always filtered to `is_active = true` — the only rows `findActiveInstructor`
 * (and therefore every endpoint that actually accepts one of these ids) would
 * ever accept, so this list can never offer a choice the write path would
 * then reject.
 */

const router = Router();

function serializeUser(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
  };
}

const listUsersQuerySchema = z.object({
  role: z.enum(['staff', 'instructor']).optional(),
});

router.get('/', authenticate, requireRole('staff'), async (req, res, next) => {
  try {
    const parsedQuery = listUsersQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json(zodErrorResponse(parsedQuery.error));
    }

    let query = db('users').select('*').where({ is_active: true }).orderBy('full_name', 'asc');
    if (parsedQuery.data.role) {
      query = query.where({ role: parsedQuery.data.role });
    }
    const users = await query;
    res.json({ users: users.map(serializeUser) });
  } catch (error) {
    next(error);
  }
});

export default router;
