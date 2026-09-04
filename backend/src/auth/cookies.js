import { isProduction } from '../config/env.js';
import { SESSION_TOKEN_TTL_SECONDS } from './tokens.js';

export const SESSION_COOKIE_NAME = 'session';

/**
 * httpOnly so the token is never reachable from JavaScript in the browser
 * (defeats the most common XSS-driven token theft); `secure` in production
 * only, since the local/CI environment usually has no TLS in front of it.
 *
 * `sameSite: 'lax'` is unconditional across every environment, and stays
 * that way *because* of how the frontend now reaches this API: production
 * (Vercel frontend, Render backend) is a same-site relationship from the
 * browser's own point of view, not a cross-site one, since the browser only
 * ever talks to the frontend's own origin — Vercel's `rewrites`
 * (`frontend/vercel.json`) proxy `/api/*` to Render server-side, invisible
 * to the browser. Local dev mirrors this with `vite.config.js`'s own dev
 * proxy. See `docs/decisions.md`, Decision 51 (which supersedes Decision 50
 * — that decision's own `sameSite: 'none'` was a real, deployed production
 * bug: Chrome treats a cookie set across genuinely different registrable
 * domains as third-party and blocks it outright, regardless of the
 * `SameSite` attribute, so `'none'` never actually worked in the browser
 * that matters most). `'lax'` gives real CSRF protection here, and the
 * proxy is what makes that compatible with a split-origin deployment at
 * all — a browser that only ever sees one origin has no cross-site request
 * to protect against in the first place.
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TOKEN_TTL_SECONDS * 1000,
  };
}

export function clearSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
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
