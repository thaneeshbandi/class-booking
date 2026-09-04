import { Router } from 'express';
import { z } from 'zod';

import { hashPassword } from '../auth/password.js';
import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { zodErrorResponse } from '../validation/respond.js';

/**
 * Staff-only account listing and creation for `staff`/`instructor` users —
 * neither is part of the original ten goals (see `docs/decisions.md`).
 *
 * `GET /` was added for the frontend milestone: the session-create,
 * recurring-generation, and add-co-instructor forms all need to offer a
 * real picker of active instructors, and nothing in the API surface before
 * this exposed one (`findActiveInstructor` in `domain/instructors.js` only
 * ever validated a single client-supplied id, never listed candidates).
 * Always filtered to `is_active = true` — the only rows `findActiveInstructor`
 * (and therefore every endpoint that actually accepts one of these ids) would
 * ever accept, so this list can never offer a choice the write path would
 * then reject.
 *
 * `POST /` was added later, on an explicit request to make staff/instructor
 * account creation a real in-app feature rather than a database-only,
 * outside-the-application operation — see that route's own comment and
 * `docs/decisions.md` for the full reasoning.
 *
 * Staff-only throughout: an instructor has no session-scheduling,
 * co-instructor-management, or account-provisioning capability (goal 3,
 * goal 5), so there is no legitimate reason for one to browse or grow the
 * studio's account list.
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

    // A `member` row is never returned here, filtered or not — this route
    // (its name, `docs/decisions.md`, and every existing caller) is the
    // studio's staff/instructor account listing, never a general "every
    // user" endpoint. Members already have their own dedicated, much
    // larger listing (`GET /api/members`); mixing member accounts into an
    // unfiltered request here would silently dump every self-registered
    // member's name and email into what is meant to be a small team roster.
    let query = db('users')
      .select('*')
      .where({ is_active: true })
      .whereIn('role', ['staff', 'instructor'])
      .orderBy('full_name', 'asc');
    if (parsedQuery.data.role) {
      query = query.where({ role: parsedQuery.data.role });
    }
    const users = await query;
    res.json({ users: users.map(serializeUser) });
  } catch (error) {
    next(error);
  }
});

const userCreateSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required.'),
  email: z.string().trim().toLowerCase().min(1, 'Email is required.').email('Enter a valid email address.'),
  // Only these two — never 'member'. A member account is created exactly
  // one way (public signup, `routes/auth.js`), and this endpoint has no
  // business minting one; restricting the enum here, not just relying on
  // staff-only self-discipline, is what actually prevents it.
  role: z.enum(['staff', 'instructor'], { errorMap: () => ({ message: "Role must be 'staff' or 'instructor'." }) }),
  // Same floor as public signup (`routes/auth.js`'s `signupSchema`) — this
  // project has no existing password-strength policy to match beyond that.
  password: z.string().min(8, 'Password must be at least 8 characters.'),
});

/**
 * Staff create staff and instructor accounts. There is deliberately no
 * self-service path to either role (see `routes/auth.js`'s signup, which
 * hardcodes `role: 'member'`), so — same as goal 1's "studio staff add
 * members" — someone with the staff role has to be the one to create the
 * next one. The very first staff account still has to come from outside the
 * running application (the seed, or a one-off script against the database)
 * — this endpoint lets every account after that be created by staff,
 * in-app, without ever touching a terminal or the database directly.
 *
 * The new account's password is set directly by the staff member creating
 * it (communicated to the new hire out of band, the same way a manager
 * hands over any other shared credential) rather than emailed as a
 * reset/invite link — this app has no real transactional email provider
 * wired up (see `docs/architecture.md`), only the dev-only OTP stand-in, so
 * an email-invite flow would be built on infrastructure that does not
 * actually exist yet. The new user can change it immediately after logging
 * in, from the profile page every role already has.
 */
router.post('/', authenticate, requireRole('staff'), async (req, res, next) => {
  try {
    const parsed = userCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const [row] = await db('users')
      .insert({
        full_name: parsed.data.fullName,
        email: parsed.data.email,
        role: parsed.data.role,
        password_hash: passwordHash,
      })
      .returning('*');
    res.status(201).json({ user: serializeUser(row) });
  } catch (error) {
    // `users_email_unique` (migration 002) is the actual enforcement — see
    // the identical pattern for `members.email` in `routes/members.js`.
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    next(error);
  }
});

export default router;
