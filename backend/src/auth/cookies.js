import { isProduction } from '../config/env.js';
import { SESSION_TOKEN_TTL_SECONDS } from './tokens.js';

export const SESSION_COOKIE_NAME = 'session';

/**
 * httpOnly so the token is never reachable from JavaScript in the browser
 * (defeats the most common XSS-driven token theft); `secure` in production
 * only, since the local/CI environment usually has no TLS in front of it.
 *
 * `sameSite` differs by environment, and it has to: local dev serves the
 * frontend and backend from the same site (different ports only), so `'lax'`
 * both works and adds real CSRF protection there. A real deployment
 * (frontend on Vercel, backend on Render — genuinely different registrable
 * domains) makes every API call a cross-site request, and browsers never
 * attach a `SameSite=Lax` cookie to a cross-site `fetch()` — only to a
 * top-level navigation. Staying on `'lax'` in production would mean login
 * "succeeds" (the `Set-Cookie` is stored) but every request after it looks
 * unauthenticated, since the cookie is never actually sent back. `'none'`
 * (which requires `secure`, already true in production) is what makes
 * cross-site `fetch()` calls carry the cookie at all.
 *
 * This isn't a CSRF hole despite dropping `Lax`'s own protection: every
 * state-changing route here only accepts `Content-Type: application/json`,
 * which forces a CORS preflight, and `middleware/cors.js` only ever allows
 * the one exact configured `FRONTEND_ORIGIN` — a third-party site's preflight
 * fails before the browser ever sends the real request, credentials or not.
 * CORS is the actual CSRF defense for this API, not `SameSite`.
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
    maxAge: SESSION_TOKEN_TTL_SECONDS * 1000,
  };
}

export function clearSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  };
}

/**
 * Express only parses `req.cookies` when the `cookie-parser` middleware is
 * installed. Rather than add a dependency for one cookie, the `Cookie`
 * request header is parsed directly here.
 */
export function readSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}
