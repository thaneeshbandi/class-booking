import { Router } from 'express';
import { z } from 'zod';

import { DUMMY_PASSWORD_HASH, verifyPassword } from '../auth/password.js';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookieOptions,
  sessionCookieOptions,
} from '../auth/cookies.js';
import { issueSessionToken } from '../auth/tokens.js';
import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).email(),
  password: z.string().min(1),
});

function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
  };
}

router.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }
    const { email, password } = parsed.data;

    const user = await db('users').where({ email }).first();

    // Verify against a real hash either way, so a non-existent email and a
    // wrong password take the same code path and cost the same time.
    const passwordMatches = await verifyPassword(
      password,
      user ? user.password_hash : DUMMY_PASSWORD_HASH,
    );

    if (!user || !user.is_active || !passwordMatches) {
      // Deliberately identical for "no such user", "wrong password" and
      // "deactivated account": which one it was is not the client's business,
      // and distinguishing them would hand an attacker a user-enumeration
      // oracle for free.
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = issueSessionToken(user.id);
    res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
    res.status(200).json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

// Unauthenticated on purpose: clearing a cookie that may already be missing,
// expired or invalid should always succeed rather than 401 first.
router.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, clearSessionCookieOptions());
  res.status(204).end();
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: toPublicUser(req.user) });
});

export default router;
