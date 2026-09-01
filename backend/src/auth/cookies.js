import { isProduction } from '../config/env.js';
import { SESSION_TOKEN_TTL_SECONDS } from './tokens.js';

export const SESSION_COOKIE_NAME = 'session';

/**
 * httpOnly so the token is never reachable from JavaScript in the browser
 * (defeats the most common XSS-driven token theft); `secure` in production
 * only, since the local/CI environment usually has no TLS in front of it;
 * `sameSite: 'lax'` blocks the cookie being sent on a cross-site POST (CSRF)
 * while still attaching on ordinary top-level navigation.
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
