import { Router } from 'express';
import { z } from 'zod';

import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../auth/password.js';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookieOptions,
  sessionCookieOptions,
} from '../auth/cookies.js';
import { issueSessionToken } from '../auth/tokens.js';
import { db } from '../db/knex.js';
import { authenticate } from '../middleware/authenticate.js';
import { zodErrorResponse } from '../validation/respond.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).email(),
  password: z.string().min(1),
});

/**
 * Public self-service signup. `role` is deliberately not a field on this
 * schema at all — not optional, not defaulted, not read from the body under
 * any name — so there is no request shape that can ask for anything but the
 * one role this endpoint is ever allowed to create. See migration
 * `011_user_role_member.js` for why a `'member'` account has no elevated
 * access anywhere else in the API.
 */
const signupSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required.'),
  email: z.string().trim().toLowerCase().min(1, 'Email is required.').email('Enter a valid email address.'),
  // 8 is a floor, not a full password policy — this project has no existing
  // password-strength requirement to match (seeded accounts predate any
  // policy), so this is the smallest reasonable bar for a new, public-facing
  // signup form rather than an invented comprehensive rule set.
  password: z.string().min(8, 'Password must be at least 8 characters.'),
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

router.post('/signup', async (req, res, next) => {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const { fullName, email, password } = parsed.data;

    const passwordHash = await hashPassword(password);

    // `role` is never taken from `req.body` — hardcoded here, the one and
    // only place a signup account's role is decided.
    const [user] = await db('users')
      .insert({ full_name: fullName, email, password_hash: passwordHash, role: 'member' })
      .returning(['id', 'email', 'full_name', 'role']);

    const token = issueSessionToken(user.id);
    res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
    res.status(201).json({ user: toPublicUser(user) });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
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
