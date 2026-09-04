import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { OTP_REQUEST_COOLDOWN_MS } from '../src/auth/otp.js';
import { verifyPassword } from '../src/auth/password.js';
import { backendRoot, env } from '../src/config/env.js';
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

async function loginAs(email, password) {
  const res = await server.request({ method: 'POST', path: '/api/auth/login', body: { email, password } });
  assert.equal(res.status, 200, `login as ${email} must succeed: ${res.raw}`);
  return res.cookie;
}

/**
 * A fresh staff or instructor account, created through `POST /api/users`
 * (staff-only) rather than reused from the seed — the seeded staff/
 * instructor accounts (`ada.okonkwo@studio.test` etc.) are shared fixtures
 * every other test file logs into with `env.SEED_PASSWORD`; actually
 * resetting one of their passwords here would break every test that runs
 * after this file in the same suite. Cleanup is by email, same as every
 * other account this file creates (see `after`, below).
 */
async function createStaffOrInstructor(role, fullName, password = 'original-password-1') {
  const staffCookie = await loginAs(seedStaff.email, env.SEED_PASSWORD);
  const email = uniqueEmail(`forgot-${role}`);
  const res = await server.request({
    method: 'POST',
    path: '/api/users',
    cookie: staffCookie,
    body: { fullName, email, role, password },
  });
  assert.equal(res.status, 201, `creating a fresh ${role} account must succeed: ${res.raw}`);
  return { email, password };
}

let seedStaff;

before(async () => {
  server = await startTestServer();
  seedStaff = await db('users').where({ role: 'staff', is_active: true }).first();
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

/** Runs the full request -> verify -> reset cycle and returns the reset's
 * own response, for tests that only care about the end state. */
async function resetPasswordFor(email, newPassword) {
  await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });
  const otp = await fetchDevOtp(email);
  const verify = await server.request({
    method: 'POST',
    path: '/api/auth/forgot-password/verify',
    body: { email, otp },
  });
  assert.equal(verify.status, 200, verify.raw);
  const reset = await server.request({
    method: 'POST',
    path: '/api/auth/forgot-password/reset',
    body: { resetToken: verify.json.resetToken, newPassword, confirmNewPassword: newPassword },
  });
  return { verify, reset };
}

describe('every login-capable role can reset its password', () => {
  it('staff account: the full flow works, and only the new password logs in afterward', async () => {
    const { email, password: oldPassword } = await createStaffOrInstructor('staff', 'Forgot Staff');
    const newPassword = 'staff-reset-password-1';
    const { reset } = await resetPasswordFor(email, newPassword);
    assert.equal(reset.status, 200, reset.raw);

    const oldLogin = await server.request({ method: 'POST', path: '/api/auth/login', body: { email, password: oldPassword } });
    assert.equal(oldLogin.status, 401, 'the old password must no longer work');
    const newLogin = await server.request({ method: 'POST', path: '/api/auth/login', body: { email, password: newPassword } });
    assert.equal(newLogin.status, 200, newLogin.raw);
    assert.equal(newLogin.json.user.role, 'staff');
  });

  it('instructor account: the full flow works, and only the new password logs in afterward', async () => {
    const { email, password: oldPassword } = await createStaffOrInstructor('instructor', 'Forgot Instructor');
    const newPassword = 'instructor-reset-password-1';
    const { reset } = await resetPasswordFor(email, newPassword);
    assert.equal(reset.status, 200, reset.raw);

    const oldLogin = await server.request({ method: 'POST', path: '/api/auth/login', body: { email, password: oldPassword } });
    assert.equal(oldLogin.status, 401);
    const newLogin = await server.request({ method: 'POST', path: '/api/auth/login', body: { email, password: newPassword } });
    assert.equal(newLogin.status, 200, newLogin.raw);
    assert.equal(newLogin.json.user.role, 'instructor');
  });

  it("member account: reset changes only the linked user's password — member profile, membership, and the link itself are untouched, and no duplicate member is created", async () => {
    const staffCookie = await loginAs(seedStaff.email, env.SEED_PASSWORD);
    const email = uniqueEmail('forgot-member');
    const createMember = await server.request({
      method: 'POST',
      path: '/api/members',
      cookie: staffCookie,
      body: { fullName: 'Staff Set Name', email, membershipExpiresOn: '2099-01-01' },
    });
    assert.equal(createMember.status, 201, createMember.raw);
    const memberId = createMember.json.member.id;

    const oldPassword = 'member-old-password-1';
    const signupRes = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'Whatever The Signup Form Had', email, password: oldPassword },
    });
    assert.equal(signupRes.status, 201, signupRes.raw);

    const newPassword = 'member-new-password-1';
    const { reset } = await resetPasswordFor(email, newPassword);
    assert.equal(reset.status, 200, reset.raw);

    const members = await db('members').where({ email });
    assert.equal(members.length, 1, 'still exactly one member row — reset never created a duplicate');
    assert.equal(String(members[0].id), String(memberId));
    assert.equal(members[0].full_name, 'Staff Set Name', "staff-set name untouched by the member's own password reset");
    assert.equal(members[0].membership_expires_on, '2099-01-01', 'membership expiry untouched');

    const user = await db('users').where({ email }).first();
    assert.equal(String(members[0].user_id), String(user.id), 'the member is still linked to the same user');

    const oldLogin = await server.request({ method: 'POST', path: '/api/auth/login', body: { email, password: oldPassword } });
    assert.equal(oldLogin.status, 401);
    const newLogin = await server.request({ method: 'POST', path: '/api/auth/login', body: { email, password: newPassword } });
    assert.equal(newLogin.status, 200, newLogin.raw);
  });

  it('the verify and reset responses never include a password hash or any user object', async () => {
    const { email } = await signup('No Leak');
    await server.request({ method: 'POST', path: '/api/auth/forgot-password/request', body: { email } });
    const otp = await fetchDevOtp(email);
    const verify = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/verify',
      body: { email, otp },
    });
    assert.equal(verify.status, 200, verify.raw);
    assert.deepEqual(Object.keys(verify.json).sort(), ['resetToken']);
    assert.doesNotMatch(verify.raw, /password_hash|passwordHash/i);

    const reset = await server.request({
      method: 'POST',
      path: '/api/auth/forgot-password/reset',
      body: {
        resetToken: verify.json.resetToken,
        newPassword: 'no-leak-password-1',
        confirmNewPassword: 'no-leak-password-1',
      },
    });
    assert.equal(reset.status, 200, reset.raw);
    assert.deepEqual(Object.keys(reset.json).sort(), ['message']);
    assert.doesNotMatch(reset.raw, /password_hash|passwordHash/i);
  });
});

/** Polls `/health` until it responds or `timeoutMs` elapses — the only
 * reliable way to know a just-spawned server process has finished starting
 * up, short of parsing its stdout. */
async function waitForHealth(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Production child process never became healthy on port ${port}: ${lastError}`);
}

describe('production behavior, verified against a real separate process', () => {
  // `isProduction` is resolved once at module import time (src/config/env.js),
  // so there is no way to flip it inside *this* already-running test process
  // — the only genuine way to prove the dev route is unreachable in
  // production is to actually run the server with NODE_ENV=production, in a
  // real separate process, and make a real HTTP request against it.
  it('GET /api/auth/forgot-password/dev/last-otp is a plain 404 when NODE_ENV=production', async () => {
    const port = 45391;
    const child = spawn(process.execPath, [path.join(backendRoot, 'src', 'server.js')], {
      env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });

    try {
      await waitForHealth(port).catch((error) => {
        throw new Error(`${error.message}\nchild output:\n${output}`);
      });

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      const healthBody = await health.json();
      assert.equal(healthBody.environment, 'production', 'confirms this really is a production-mode process');

      const devRoute = await fetch(
        `http://127.0.0.1:${port}/api/auth/forgot-password/dev/last-otp?email=anyone@example.test`,
      );
      assert.equal(devRoute.status, 404, 'the dev OTP route must not exist at all in production');
      const body = await devRoute.json();
      assert.equal(body.error, 'Not found', 'the app\'s own ordinary 404 — not a route-specific "forbidden"');
    } finally {
      child.kill();
    }
  });

  it('production with no email provider configured fails safely: the request still returns the generic response, and nothing OTP-shaped is ever logged', async () => {
    const port = 45392;
    // Deliberately no EMAIL_PROVIDER (and therefore no RESEND_API_KEY/
    // SMTP_*/EMAIL_WEBHOOK_* either) — the one scenario `selectProvider`'s
    // own production guard exists for. An empty string would fail Zod's own
    // enum validation at startup (`.optional()` allows a missing key, not an
    // empty one) before the app even got this far, so the key is actually
    // deleted, not just blanked.
    const childEnv = { ...process.env, NODE_ENV: 'production', PORT: String(port) };
    delete childEnv.EMAIL_PROVIDER;
    const child = spawn(process.execPath, [path.join(backendRoot, 'src', 'server.js')], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });

    try {
      await waitForHealth(port).catch((error) => {
        throw new Error(`${error.message}\nchild output:\n${output}`);
      });

      const email = `prod-no-provider-${Date.now()}@example.test`;
      const password = 'a-real-password-123';
      const signup = await fetch(`http://127.0.0.1:${port}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: 'Prod No Provider', email, password }),
      });
      assert.equal(signup.status, 201);

      const request = await fetch(`http://127.0.0.1:${port}/api/auth/forgot-password/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      assert.equal(request.status, 200, 'the request itself must still succeed with the ordinary generic response');
      const requestBody = await request.json();
      assert.deepEqual(
        Object.keys(requestBody).sort(),
        ['cooldownSeconds', 'expiresInMinutes', 'message'],
        'never a hint that the email send actually failed',
      );

      // The send is fire-and-forget (see routes/auth.js), so the failure is
      // logged asynchronously, slightly after the response above already
      // returned — poll briefly for it rather than assuming it has already
      // landed the instant the request resolves.
      const deadline = Date.now() + 5_000;
      while (!output.includes('[forgot-password] failed to send OTP email') && Date.now() < deadline) {
        await delay(50);
      }
      assert.match(output, /\[forgot-password\] failed to send OTP email/, `expected a safe, logged failure; got:\n${output}`);
      assert.match(output, /EMAIL_PROVIDER must be set to a real provider/);
      assert.doesNotMatch(output, /\b\d{6}\b/, 'no 6-digit OTP-shaped value may ever appear in the logs');
      assert.doesNotMatch(output, new RegExp(password), "the signup password must never appear in the logs either");
    } finally {
      child.kill();
    }
  });
});
