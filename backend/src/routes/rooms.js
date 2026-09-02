import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { zodErrorResponse } from '../validation/respond.js';

/**
 * Read-only room listing, open to any authenticated user (staff or
 * instructor) — the same visibility `routes/classes.js` gives class listing,
 * for the same reason: an instructor viewing their own sessions needs to
 * resolve a session's `roomId` to a display name, and staff need this list
 * to populate a room picker when scheduling. There is no room-management UI
 * in the brief (create/edit/archive a room), so only the listing this
 * frontend genuinely needs exists here — see `docs/decisions.md`.
 */

const router = Router();

function serializeRoom(row) {
  return {
    id: row.id,
    name: row.name,
    archivedAt: row.archived_at,
  };
}

const listRoomsQuerySchema = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

router.get('/', authenticate, async (req, res, next) => {
  try {
    const parsedQuery = listRoomsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json(zodErrorResponse(parsedQuery.error));
    }

    let query = db('rooms').select('*').orderBy('name', 'asc');
    if (!parsedQuery.data.includeArchived) {
      query = query.whereNull('archived_at');
    }
    const rooms = await query;
    res.json({ rooms: rooms.map(serializeRoom) });
  } catch (error) {
    next(error);
  }
});

export default router;
