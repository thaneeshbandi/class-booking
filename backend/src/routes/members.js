import { Router } from 'express';

import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';

/**
 * Staff-only, read-only. Instructor access to members is not part of the
 * README brief — an instructor's data access is scoped to sessions they are
 * authorized to see, not to the studio's whole membership list — so this is
 * denied by default rather than granted absent a stated reason to allow it.
 * Creating and editing members is goal 1's staff description but not
 * implemented here; this exists to exercise staff-only authorization.
 */

const router = Router();

function serializeMember(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    membershipExpiresOn: row.membership_expires_on,
  };
}

router.get('/', authenticate, requireRole('staff'), async (_req, res, next) => {
  try {
    const members = await db('members').select('*').orderBy('full_name', 'asc');
    res.json({ members: members.map(serializeMember) });
  } catch (error) {
    next(error);
  }
});

export default router;
