import { Router } from 'express';
import { z } from 'zod';

import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../auth/password.js';
import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { zodErrorResponse } from '../validation/respond.js';

/**
 * The profile page every authenticated user has, regardless of role —
 * staff, instructor and member alike. Nothing here can change `role`: it is
 * never a field on any schema below, the same "not a field at all" pattern
 * `routes/auth.js#signupSchema` already uses for the same reason.
 *
 * Email is deliberately read-only (no `PATCH` field for it). It is the
 * account's identity for login, and — since signup — the one-time matching
 * key `domain/memberLinking.js` uses to find a staff-created member to
 * claim. Letting a user change it later would either leave a stale link (if
 * the linked member's own email isn't updated to match) or require quietly
 * re-running the linking search against a *second* email, which risks
 * exactly the silent-account-merge the linking design goes out of its way
 * to avoid at signup. See `docs/decisions.md`.
 */

const router = Router();

function serializeProfile(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    createdAt: user.created_at,
  };
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    const row = await db('users').where({ id: req.user.id }).first();
    res.json({ profile: serializeProfile(row) });
  } catch (error) {
    next(error);
  }
});

const updateProfileSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required.'),
});

router.patch('/', authenticate, async (req, res, next) => {
  try {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }

    const [row] = await db('users')
      .where({ id: req.user.id })
      .update({ full_name: parsed.data.fullName, updated_at: db.fn.now() })
      .returning('*');
    res.json({ profile: serializeProfile(row) });
  } catch (error) {
    next(error);
  }
});

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required.'),
    newPassword: z.string().min(8, 'New password must be at least 8 characters.'),
    confirmNewPassword: z.string().min(1, 'Please confirm your new password.'),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: 'New password and confirmation do not match.',
    path: ['confirmNewPassword'],
  });

/**
 * The current session stays valid after a password change: `auth/tokens.js`
 * is a stateless HMAC token with no server-side revocation list, so "sign
 * out every other session" would need a new mechanism (a token version or
 * issued-at floor on `users`) this milestone does not add — see
 * `docs/decisions.md` for the tradeoff this accepts and why it is the
 * simplest behavior consistent with the existing token architecture.
 */
router.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const { currentPassword, newPassword } = parsed.data;

    // Re-read the hash fresh — `authenticate` never selects it onto
    // `req.user` — verified against a real hash either way to avoid a
    // timing signal, the same pattern `routes/auth.js#login` uses.
    const row = await db('users').where({ id: req.user.id }).first();
    const matches = await verifyPassword(currentPassword, row ? row.password_hash : DUMMY_PASSWORD_HASH);
    if (!row || !matches) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const passwordHash = await hashPassword(newPassword);
    await db('users')
      .where({ id: req.user.id })
      .update({ password_hash: passwordHash, updated_at: db.fn.now() });
    res.status(200).json({ message: 'Your password has been changed.' });
  } catch (error) {
    next(error);
  }
});

export default router;
