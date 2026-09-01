import crypto from 'node:crypto';

import { env } from '../config/env.js';

/**
 * A minimal, dependency-free JWT (HS256): three base64url segments —
 * header, payload, HMAC-SHA256 signature — joined with '.'. This is the whole
 * format; no library is pulled in for it because Node's built-in `crypto`
 * already provides everything an HMAC-signed token needs, and hand-rolling
 * three lines of base64url is far less risk than an unreviewed dependency.
 *
 * The token is stateless and carries only the user id and its own expiry.
 * Deliberately absent: role, and any other authorization claim. Every
 * authenticated request re-reads the user row from the database (see
 * middleware/authenticate.js), so a role change or `is_active = false` takes
 * effect on the very next request rather than waiting for the token to
 * expire. A JWT that embedded role would reintroduce the stale-permissions
 * window this design exists to avoid.
 */

const ALGORITHM = 'HS256';
export const SESSION_TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function encodeSegment(value) {
  return base64url(JSON.stringify(value));
}

function sign(headerAndPayload) {
  return crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(headerAndPayload)
    .digest('base64url');
}

export function issueSessionToken(userId) {
  const header = encodeSegment({ alg: ALGORITHM, typ: 'JWT' });
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = encodeSegment({
    sub: userId,
    iat: issuedAt,
    exp: issuedAt + SESSION_TOKEN_TTL_SECONDS,
  });
  const signature = sign(`${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

/**
 * Returns the decoded claims for a well-formed, correctly-signed,
 * unexpired token, or `null` for anything else — malformed input, a bad
 * signature, or an expired token are all just "not authenticated", not
 * distinct error conditions the caller needs to branch on.
 */
export function verifySessionToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expectedSignature = sign(`${header}.${payload}`);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  // `users.id` is a bigint; node-postgres returns bigint columns as strings
  // (a JS number cannot safely represent the full int8 range), so `sub` is
  // carried through as a string end to end rather than coerced to a number.
  if (
    typeof claims.sub !== 'string' ||
    !/^[1-9][0-9]*$/.test(claims.sub) ||
    typeof claims.exp !== 'number' ||
    claims.exp < Math.floor(Date.now() / 1000)
  ) {
    return null;
  }

  return claims;
}
