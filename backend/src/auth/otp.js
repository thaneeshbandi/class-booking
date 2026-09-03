import crypto from 'node:crypto';

import { env } from '../config/env.js';

/**
 * Password-reset OTP generation and hashing. A 6-digit numeric code,
 * generated with `crypto.randomInt` (cryptographically secure — the same
 * `node:crypto` module `auth/tokens.js` already uses rather than pulling in
 * a dependency for it).
 *
 * Only a hash of the code is ever stored (`password_reset_otps.otp_hash`,
 * migration 013) — never the plaintext. Hashing here is a keyed HMAC, not
 * Argon2id: unlike a password, a 6-digit code has no meaningful work-factor
 * to add (an attacker who has the database already has more direct wins),
 * and the security of this flow instead rests on `OTP_MAX_ATTEMPTS` and
 * `OTP_TTL_MS` bounding how many guesses are possible before a code is
 * useless. Keying the HMAC with `JWT_SECRET` (already the one server-side
 * secret this app requires) makes the hash unforgeable without it, the same
 * property `auth/tokens.js`'s session-token signature relies on.
 */

const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_REQUEST_COOLDOWN_MS = 30 * 1000;

export function generateOtp() {
  const max = 10 ** OTP_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(OTP_LENGTH, '0');
}

export function hashOtp(otp) {
  return crypto.createHmac('sha256', env.JWT_SECRET).update(otp).digest('hex');
}

/** Timing-safe comparison — the whole point of hashing is defeated by a
 * short-circuiting `===` on the comparison step. */
export function otpMatchesHash(otp, otpHash) {
  const provided = Buffer.from(hashOtp(otp));
  const expected = Buffer.from(otpHash);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}
