import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { OTP_REQUEST_COOLDOWN_MS } from '../src/auth/otp.js';
import { verifyPassword } from '../src/auth/password.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Forgot-password by email OTP: `POST /api/auth/forgot-password/{request,
 * verify,reset}`, exercised over real HTTP against a running app and a live
 * database.
 *
 * The dev/test-only `GET /api/auth/forgot-password/dev/last-otp` route is
 * what retrieves the raw OTP here, standing in for reading a real inbox —
 * this project has no email provider to make a real call to in tests (see
 * `src/email/emailService.js`), and this route is registered only when
 * `NODE_ENV !== 'production'` (true for `npm test`), so exercising it here
 * is exactly the "test/dev email adapter" the milestone asks for.
 */

let server;
const RUN = Date.now();
const createdUserEmails = [];
let counter = 0;

function uniqueEmail(prefix) {
  counter += 1;
  const email = `${prefix}-${RUN}-${counter}@example.test`;
  createdUserEmails.push(email);
  return email;
}

async function signup(fullName, password = 'original-password-1') {
  const email = uniqueEmail('forgot');
  const res = await server.request({
    method: 'POST',
    path: '/api/auth/signup',
    body: { fullName, email, password },
  });
  assert.equal(res.status, 201);
  return { email, password };
}

async function fetchDevOtp(email) {
  const res = await server.request({
    method: 'GET',
    path: `/api/auth/forgot-password/dev/last-otp?email=${encodeURIComponent(email)}`,
  });
  assert.equal(res.status, 200, `expected a dev OTP to exist for ${email}: ${res.raw}`);
  return res.json.otp;
}

before(async () => {
  server = await startTestServer();
});

after(async () => {
  const users = await db('users').whereIn('email', createdUserEmails).select('id');
  const userIds = users.map((row) => row.id);
  if (userIds.length > 0) {
    await db('password_reset_otps').whereIn('user_id', userIds).del();
    await db('members').whereIn('user_id', userIds).del();
  }
  await db('users').whereIn('email', createdUserEmails).del();
  await server.stop();
  await closeConnection();
});

describe('POST /api/auth/forgot-password/request', () => {
  it('returns the same generic message for an existing account and a nonexistent one', async () => {
    const { email } = await signup('Real Account Holder');

    const real = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/request',
      body: { email },
    });
    const fake = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/request',
      body: { email: 'no-such-account-anywhere@example.test' },
    });

    assert.equal(real.status, 200);
    assert.equal(fake.status, 200);
    assert.equal(real.json.message, fake.json.message);
  });

  it('actually generates a retrievable OTP for a real account, and none for a nonexistent one', async () => {
    const { email } = await signup('Otp Recipient');
    await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });

    const otp = await fetchDevOtp(email);
    assert.match(otp, /^\d{6}$/);

    const missing = await server.request({
      method: 'GET',
      path: `/api/auth/forgot-password/dev/last-otp?email=${encodeURIComponent('nobody-at-all@example.test')}`,
    });
    assert.equal(missing.status, 404);
  });

  it('never stores the OTP in plaintext', async () => {
    const { email } = await signup('Hash Only');
    await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });
    const otp = await fetchDevOtp(email);

    const user = await db('users').where({ email }).first();
    const record = await db('password_reset_otps').where({ user_id: user.id }).orderBy('created_at', 'desc').first();
    assert.notEqual(record.otp_hash, otp);
    assert.equal(record.otp_hash.length >= 32, true, 'stored value is a hash, not a 6-digit code');
  });
});

describe('POST /api/auth/forgot-password/verify + reset', () => {
  it('the full happy path: request -> verify -> reset -> login with the new password', async () => {
    const { email } = await signup('Full Flow', 'original-password-1');
    await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });
    const otp = await fetchDevOtp(email);

    const verify = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/verify',
      body: { email, otp },
    });
    assert.equal(verify.status, 200);
    assert.ok(verify.json.resetToken);

    const reset = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/reset',
      body: {
        resetToken: verify.json.resetToken,
        newPassword: 'reset-flow-new-password',
        confirmNewPassword: 'reset-flow-new-password',
      },
    });
    assert.equal(reset.status, 200);

    const row = await db('users').where({ email }).first();
    const matchesNew = await verifyPassword('reset-flow-new-password', row.password_hash);
    assert.equal(matchesNew, true);

    const login = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email, password: 'reset-flow-new-password' },
    });
    assert.equal(login.status, 200);
  });

  it('rejects an incorrect OTP', async () => {
    const { email } = await signup('Wrong Otp');
    await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });
    const otp = await fetchDevOtp(email);
    const wrong = otp === '000000' ? '111111' : '000000';

    const res = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/verify',
      body: { email, otp: wrong },
    });
    assert.equal(res.status, 400);
    assert.doesNotMatch(res.raw, /database|sql|stack/i);
  });

  it('rejects a reused OTP (already consumed via a completed reset)', async () => {
    const { email } = await signup('Reuse Otp');
    await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });
    const otp = await fetchDevOtp(email);

    const firstVerify = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/verify',
      body: { email, otp },
    });
    assert.equal(firstVerify.status, 200);
    await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/reset',
      body: {
        resetToken: firstVerify.json.resetToken,
        newPassword: 'first-reset-password',
        confirmNewPassword: 'first-reset-password',
      },
    });

    const secondVerify = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/verify',
      body: { email, otp },
    });
    assert.equal(secondVerify.status, 400, 'the same OTP cannot be verified again once consumed');
  });

  it('rejects too many incorrect attempts even with the eventually-correct code', async () => {
    const { email } = await signup('Too Many Attempts');
    await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });
    const otp = await fetchDevOtp(email);
    const wrong = otp === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i += 1) {
      const attempt = await server.request({
        method: 'POST',
        path: '/api/auth/forgot-password/verify',
        body: { email, otp: wrong },
      });
      assert.equal(attempt.status, 400);
    }

    const finalTry = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/verify',
      body: { email, otp },
    });
    assert.equal(finalTry.status, 400, 'the correct code is rejected once the attempt limit is exceeded');
  });

  it('requesting a new OTP invalidates the previous one, once the cooldown has passed', async () => {
    const { email } = await signup('Regenerate Otp');
    await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });
    const firstOtp = await fetchDevOtp(email);

    const user = await db('users').where({ email }).first();
    // Backdate the first OTP's `created_at` so the cooldown has already
    // elapsed, without a real sleep in the test.
    await db('password_reset_otps')
      .where({ user_id: user.id })
      .update({ created_at: new Date(Date.now() - OTP_REQUEST_COOLDOWN_MS - 1000) });

    await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });
    const secondOtp = await fetchDevOtp(email);

    const oldOtpAttempt = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/verify',
      body: { email, otp: firstOtp },
    });
    assert.equal(oldOtpAttempt.status, 400, 'the superseded first OTP no longer verifies');

    const newOtpAttempt = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/verify',
      body: { email, otp: secondOtp },
    });
    assert.equal(newOtpAttempt.status, 200, 'the newest OTP still verifies');
  });

  it('a rapid second request during the cooldown does not replace the still-live OTP', async () => {
    const { email } = await signup('Cooldown Active');
    await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });
    const firstOtp = await fetchDevOtp(email);

    // No backdating this time — the cooldown is still active.
    await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });

    const verify = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/verify',
      body: { email, otp: firstOtp },
    });
    assert.equal(verify.status, 200, 'the original OTP is still the live one during cooldown');
  });

  it('rejects reset with a malformed/invalid reset token', async () => {
    const res = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/reset',
      body: { resetToken: 'not-a-real-token', newPassword: 'a-real-password-123', confirmNewPassword: 'a-real-password-123' },
    });
    assert.equal(res.status, 400);
  });

  it('reset rejects a new/confirm mismatch', async () => {
    const { email } = await signup('Reset Mismatch');
    await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });
    const otp = await fetchDevOtp(email);
    const verify = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/verify',
      body: { email, otp },
    });

    const res = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/reset',
      body: { resetToken: verify.json.resetToken, newPassword: 'a-real-password-123', confirmNewPassword: 'different' },
    });
    assert.equal(res.status, 400);
  });

  it('password reset only ever works after a successful verify — reset cannot be called with just an email/otp', async () => {
    const { email } = await signup('No Skip Verify');
    await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });
    const otp = await fetchDevOtp(email);

    const res = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/reset',
      body: { email, otp, newPassword: 'a-real-password-123', confirmNewPassword: 'a-real-password-123' },
    });
    assert.equal(res.status, 400, 'reset has no email/otp fields — a resetToken is required');
  });
});
