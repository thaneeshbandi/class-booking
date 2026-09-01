import { readSessionCookie } from '../auth/cookies.js';
import { verifySessionToken } from '../auth/tokens.js';
import { db } from '../db/knex.js';

/**
 * Establishes `req.user` from the signed session cookie, or rejects with 401.
 *
 * The token proves identity only (a user id); it is never trusted for role or
 * active-status. Both are re-read from `users` on every request, so a role
 * change, a deactivation, or (via the resource-level checks that run after
 * this) a co-instructor removal all take effect on the very next request
 * rather than waiting for a token to expire.
 */
export async function authenticate(req, res, next) {
  try {
    const token = readSessionCookie(req);
    const claims = token ? verifySessionToken(token) : null;
    if (!claims) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const user = await db('users')
      .select('id', 'email', 'full_name', 'role', 'is_active')
      .where({ id: claims.sub })
      .first();

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}
