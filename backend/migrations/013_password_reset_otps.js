import { grantAppTablePrivileges } from '../src/db/grants.js';

/**
 * 013 — password-reset OTPs.
 *
 * Keyed by `user_id`, not by a raw email string: the request endpoint already
 * has to look the user up by normalized email to decide whether to generate
 * an OTP at all (and returns the same generic response either way — see
 * `routes/auth.js`), so by the time a row is written here the account is
 * known to exist. Storing the id instead of a second copy of the email
 * avoids a second place email normalization could ever drift.
 *
 * `otp_hash` is exactly that — never the plaintext code. Verifying re-hashes
 * the submitted code and compares hashes (see `auth/otp.js`); nothing reads
 * this column back and shows it to anyone.
 *
 * `attempts` bounds brute-forcing a 6-digit code against one row;
 * `consumed_at` makes a code single-use; `verified_at` records that the code
 * was correctly entered without yet spending it, because this application's
 * flow is enter-code-then-set-new-password as two separate requests (see the
 * `/verify` and `/reset` routes) rather than one combined submission —
 * `verified_at` is what a short-lived reset token, issued at `/verify`, is
 * checked against at `/reset`. `expires_at` and the `created_at` index are
 * what a periodic or lazy cleanup (`domain/otpCleanup.js`) prunes stale rows
 * by; nothing about correctness depends on that cleanup ever running, since
 * every read here already filters on `expires_at`.
 */

export async function up(knex) {
  await knex.raw(String.raw`
    CREATE TABLE password_reset_otps (
      id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      otp_hash     text        NOT NULL,
      attempts     int         NOT NULL DEFAULT 0,
      created_at   timestamptz NOT NULL DEFAULT now(),
      expires_at   timestamptz NOT NULL,
      verified_at  timestamptz,
      consumed_at  timestamptz,

      CONSTRAINT password_reset_otps_attempts_nonneg CHECK (attempts >= 0),
      CONSTRAINT password_reset_otps_expires_after_created CHECK (expires_at > created_at)
    )
  `);

  // Every request this table serves — "does this user have a live OTP right
  // now" (cooldown/invalidate-on-regenerate) and "verify this code" — looks
  // up by user_id first and wants the newest row; one index carries both.
  await knex.raw(`
    CREATE INDEX password_reset_otps_user_id_created_at
      ON password_reset_otps (user_id, created_at DESC)
  `);

  await grantAppTablePrivileges(knex, 'password_reset_otps');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS password_reset_otps');
}
