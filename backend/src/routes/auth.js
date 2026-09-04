import { Router } from 'express';
import { z } from 'zod';

import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../auth/password.js';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookieOptions,
  sessionCookieOptions,
} from '../auth/cookies.js';
import { OTP_MAX_ATTEMPTS, OTP_REQUEST_COOLDOWN_MS, OTP_TTL_MS, generateOtp, hashOtp, otpMatchesHash } from '../auth/otp.js';
import { issuePasswordResetToken, verifyPasswordResetToken } from '../auth/resetTokens.js';
import { issueSessionToken } from '../auth/tokens.js';
import { isProduction } from '../config/env.js';
import { db } from '../db/knex.js';
import { linkOrCreateMemberForSignup } from '../domain/memberLinking.js';
import { sendOtpEmail, sentEmails } from '../email/emailService.js';
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
 *
 * Signup also decides the account's `members` row (see
 * `domain/memberLinking.js`): an existing staff-created member matching this
 * email is claimed via `members.user_id`, never duplicated; no match creates
 * a fresh member. See `docs/decisions.md` for the linking rules.
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

    // One transaction: the `users` row and its `members` link-or-create are
    // never separately committed, so a signup can never leave a user with no
    // member, or a member linked to a user that doesn't exist.
    const user = await db.transaction(async (trx) => {
      // `role` is never taken from `req.body` — hardcoded here, the one and
      // only place a signup account's role is decided.
      const [insertedUser] = await trx('users')
        .insert({ full_name: fullName, email, password_hash: passwordHash, role: 'member' })
        .returning(['id', 'email', 'full_name', 'role']);

      await linkOrCreateMemberForSignup(trx, { userId: insertedUser.id, fullName, email });

      return insertedUser;
    });

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

/**
 * Forgot password — email OTP. Three requests: request a code, verify it
 * (returns a short-lived reset token), then reset the password with that
 * token. Every response from `/forgot-password/request` is identical
 * whether or not the email belongs to an account — this is the one place in
 * the auth surface where revealing "no such account" would be a real
 * information leak (an attacker probing which emails have accounts here),
 * unlike login's 401, which is already deliberately generic for the same
 * reason.
 */
const forgotPasswordRequestSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Email is required.').email('Enter a valid email address.'),
});

// `expiresInMinutes` is a fixed constant (`OTP_TTL_MS`, never anything
// per-request), so surfacing it here doesn't weaken the response's own
// anti-enumeration guarantee below — every caller sees the same value
// regardless of whether an OTP was actually generated. It exists so the
// frontend's expiry copy is read from the one place the real TTL lives,
// never a second, hand-typed "10 minutes" that could quietly drift from it.
const GENERIC_REQUEST_RESPONSE = {
  message: 'If an account exists for that email, a verification code has been sent.',
  expiresInMinutes: Math.round(OTP_TTL_MS / 60_000),
  cooldownSeconds: Math.round(OTP_REQUEST_COOLDOWN_MS / 1000),
};

router.post('/forgot-password/request', async (req, res, next) => {
  try {
    const parsed = forgotPasswordRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const { email } = parsed.data;

    const user = await db('users').where({ email, is_active: true }).first();
    if (user) {
      const latest = await db('password_reset_otps')
        .where({ user_id: user.id })
        .orderBy('created_at', 'desc')
        .first();
      const cooldownActive =
        latest && Date.now() - new Date(latest.created_at).getTime() < OTP_REQUEST_COOLDOWN_MS;

      // A request during cooldown is a silent no-op (still the same generic
      // response) rather than a visible "please wait" — that distinction
      // would itself confirm the account exists.
      if (!cooldownActive) {
        const otp = generateOtp();
        await db('password_reset_otps').insert({
          user_id: user.id,
          otp_hash: hashOtp(otp),
          expires_at: new Date(Date.now() + OTP_TTL_MS),
        });
        // Nothing explicitly invalidates the previous OTP row — `/verify`
        // and `/reset` only ever consider the newest row for a user, so an
        // older one is already unusable the moment a new one is inserted.
        //
        // Deliberately NOT awaited: a real provider (SMTP/webhook) makes a
        // genuine network call here, and awaiting it would make this
        // response's latency depend on whether an email was actually sent —
        // a timing side-channel an attacker could use to distinguish a real
        // account (waits on the network call) from a nonexistent one
        // (returns immediately) even though the response body is identical
        // either way. The response below is sent as soon as the OTP row is
        // committed; the send happens in the background, and a failure is
        // only ever logged server-side — the client already got the one
        // honest answer this endpoint ever gives.
        sendOtpEmail(user.email, otp).catch((error) => {
          console.error('[forgot-password] failed to send OTP email:', error);
        });
      }
    }

    res.status(200).json(GENERIC_REQUEST_RESPONSE);
  } catch (error) {
    next(error);
  }
});

const forgotPasswordVerifySchema = z.object({
  email: z.string().trim().toLowerCase().min(1).email(),
  otp: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
});

const INVALID_OTP_RESPONSE = { error: 'That code is invalid or has expired.' };

router.post('/forgot-password/verify', async (req, res, next) => {
  try {
    const parsed = forgotPasswordVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const { email, otp } = parsed.data;

    const user = await db('users').where({ email, is_active: true }).first();
    if (!user) {
      return res.status(400).json(INVALID_OTP_RESPONSE);
    }

    const outcome = await db.transaction(async (trx) => {
      const record = await trx('password_reset_otps')
        .where({ user_id: user.id })
        .orderBy('created_at', 'desc')
        .forUpdate()
        .first();

      if (!record || record.consumed_at || new Date(record.expires_at) < new Date()) {
        return { valid: false };
      }
      if (record.attempts >= OTP_MAX_ATTEMPTS) {
        return { valid: false };
      }
      if (!otpMatchesHash(otp, record.otp_hash)) {
        await trx('password_reset_otps').where({ id: record.id }).increment('attempts', 1);
        return { valid: false };
      }

      await trx('password_reset_otps').where({ id: record.id }).update({ verified_at: trx.fn.now() });
      return { valid: true, otpId: record.id };
    });

    if (!outcome.valid) {
      return res.status(400).json(INVALID_OTP_RESPONSE);
    }

    const resetToken = issuePasswordResetToken(user.id, outcome.otpId);
    res.status(200).json({ resetToken });
  } catch (error) {
    next(error);
  }
});

const INVALID_RESET_TOKEN_RESPONSE = {
  error: 'This reset link is invalid or has expired. Please request a new code.',
};

const forgotPasswordResetSchema = z
  .object({
    resetToken: z.string().min(1, 'Missing reset token.'),
    newPassword: z.string().min(8, 'New password must be at least 8 characters.'),
    confirmNewPassword: z.string().min(1, 'Please confirm your new password.'),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: 'New password and confirmation do not match.',
    path: ['confirmNewPassword'],
  });

router.post('/forgot-password/reset', async (req, res, next) => {
  try {
    const parsed = forgotPasswordResetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(zodErrorResponse(parsed.error));
    }
    const { resetToken, newPassword } = parsed.data;

    const claims = verifyPasswordResetToken(resetToken);
    if (!claims) {
      return res.status(400).json(INVALID_RESET_TOKEN_RESPONSE);
    }

    const passwordHash = await hashPassword(newPassword);

    const ok = await db.transaction(async (trx) => {
      const record = await trx('password_reset_otps').where({ id: claims.otpId }).forUpdate().first();
      if (
        !record ||
        String(record.user_id) !== claims.sub ||
        !record.verified_at ||
        record.consumed_at ||
        new Date(record.expires_at) < new Date()
      ) {
        return false;
      }
      await trx('password_reset_otps').where({ id: record.id }).update({ consumed_at: trx.fn.now() });
      // The session-token architecture is stateless (auth/tokens.js — no
      // server-side revocation list), so this deliberately does not attempt
      // to invalidate any other active session; there wasn't one here to
      // begin with (this flow is unauthenticated by design). Documented as
      // a decision in docs/decisions.md, alongside the same call for
      // `POST /api/profile/change-password`.
      await trx('users').where({ id: claims.sub }).update({ password_hash: passwordHash, updated_at: trx.fn.now() });
      return true;
    });

    if (!ok) {
      return res.status(400).json(INVALID_RESET_TOKEN_RESPONSE);
    }
    res.status(200).json({ message: 'Your password has been reset. You can now log in with your new password.' });
  } catch (error) {
    next(error);
  }
});

/**
 * Dev/test-only OTP retrieval. Registered only when `!isProduction` — in a
 * production build this route simply does not exist (falls through to the
 * app's ordinary 404), so there is no configuration flag to forget to flip;
 * the safety is structural. Used by Playwright, which runs as a separate
 * process from the backend and so cannot import `sentEmails` directly the
 * way the in-process backend test suite does.
 */
if (!isProduction) {
  router.get('/forgot-password/dev/last-otp', (req, res) => {
    const email = String(req.query.email ?? '').trim().toLowerCase();
    const entry = [...sentEmails].reverse().find((sent) => sent.to === email);
    if (!entry) {
      return res.status(404).json({ error: 'No dev email found for that address.' });
    }
    // A bare 6-digit run, not tied to one exact phrasing of the email copy
    // (`email/emailService.js#buildOtpEmailContent`) — the OTP is the only
    // 6-digit number that template ever contains.
    const match = /\b(\d{6})\b/.exec(entry.text);
    res.json({ otp: match ? match[1] : null });
  });
}

export default router;
