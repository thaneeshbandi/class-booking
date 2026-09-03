import crypto from 'node:crypto';

import { env } from '../config/env.js';

/**
 * A short-lived token proving "this email+OTP pair was just verified",
 * handed to the client by `POST /api/auth/forgot-password/verify` and
 * required by `POST /api/auth/forgot-password/reset` — so the reset step
 * never needs the raw OTP resubmitted, and never trusts a bare `userId` from
 * the client either.
 *
 * Deliberately a separate implementation from `auth/tokens.js`'s session
 * token, not a reuse of it: the claim shape is different (`otpId` and a
 * `purpose` tag, no role or long TTL) and the two must never be accepted for
 * each other's endpoint. Reusing the exact same encode/verify functions
 * would make that a one-line mistake to introduce later (pass a session
 * token where a reset token is expected, or vice versa) rather than a type
 * error; keeping them structurally distinct — same small HMAC pattern
 * `tokens.js` already uses, Node's built-in `crypto` only — costs a dozen
 * duplicate lines in exchange for that token confusion being impossible.
 */

const PURPOSE = 'password-reset';
const RESET_TOKEN_TTL_SECONDS = 10 * 60;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function encodeSegment(value) {
  return base64url(JSON.stringify(value));
}

function sign(headerAndPayload) {
  return crypto.createHmac('sha256', env.JWT_SECRET).update(headerAndPayload).digest('base64url');
}

export function issuePasswordResetToken(userId, otpId) {
  const header = encodeSegment({ alg: 'HS256', typ: 'JWT' });
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = encodeSegment({
    sub: String(userId),
    otpId: String(otpId),
    purpose: PURPOSE,
    iat: issuedAt,
    exp: issuedAt + RESET_TOKEN_TTL_SECONDS,
  });
  const signature = sign(`${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

/** Returns `{ sub, otpId }` for a well-formed, correctly-signed, unexpired
 * password-reset token, or `null` for anything else — including a
 * perfectly valid *session* token, which has no `purpose` claim at all. */
export function verifyPasswordResetToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expectedSignature = sign(`${header}.${payload}`);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    claims.purpose !== PURPOSE ||
    typeof claims.sub !== 'string' ||
    !/^[1-9][0-9]*$/.test(claims.sub) ||
    typeof claims.otpId !== 'string' ||
    !/^[1-9][0-9]*$/.test(claims.otpId) ||
    typeof claims.exp !== 'number' ||
    claims.exp < Math.floor(Date.now() / 1000)
  ) {
    return null;
  }

  return { sub: claims.sub, otpId: claims.otpId };
}
