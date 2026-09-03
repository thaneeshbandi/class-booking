import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { verifyPassword } from '../src/auth/password.js';
import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * `GET/PATCH /api/profile` and `POST /api/profile/change-password` —
 * available to every authenticated role (staff, instructor, member), tested
 * over real HTTP against a running app and a live database.
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

async function signupAndLogin(fullName, password = 'a-real-password-123') {
  const email = uniqueEmail('profile');
  const res = await server.request({
    method: 'POST',
    path: '/api/auth/signup',
    body: { fullName, email, password },
  });
  assert.equal(res.status, 201);
  return { email, password, cookie: res.cookie, user: res.json.user };
}

function loginAs(user) {
  return server
    .request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: user.email, password: env.SEED_PASSWORD },
    })
    .then((res) => {
      assert.equal(res.status, 200, `login as ${user.email} must succeed`);
      return res.cookie;
    });
}

before(async () => {
  server = await startTestServer();
});

after(async () => {
  const users = await db('users').whereIn('email', createdUserEmails).select('id');
  const userIds = users.map((row) => row.id);
  if (userIds.length > 0) await db('members').whereIn('user_id', userIds).del();
  await db('users').whereIn('email', createdUserEmails).del();
  await server.stop();
  await closeConnection();
});

describe('GET /api/profile', () => {
  it('returns the authenticated user, never a password hash', async () => {
    const { cookie, user } = await signupAndLogin('Profile Reader');
    const res = await server.request({ method: 'GET', path: '/api/profile', cookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.profile.email, user.email);
    assert.equal(res.json.profile.fullName, 'Profile Reader');
    assert.equal(res.json.profile.role, 'member');
    assert.ok(res.json.profile.createdAt);
    assert.equal('password_hash' in res.json.profile, false);
    assert.doesNotMatch(res.raw, /\$argon2/);
  });

  it('requires authentication', async () => {
    const res = await server.request({ method: 'GET', path: '/api/profile' });
    assert.equal(res.status, 401);
  });

  it('works for a staff account and a real seeded instructor account, and role is never editable through this page', async () => {
    const staff = await db('users').where({ role: 'staff', is_active: true }).first();
    const cookie = await loginAs(staff);
    const res = await server.request({ method: 'GET', path: '/api/profile', cookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.profile.role, 'staff');
  });
});

describe('PATCH /api/profile', () => {
  it('lets a user edit their own full name', async () => {
    const { cookie } = await signupAndLogin('Original Name');
    const res = await server.request({
      method: 'PATCH',
      path: '/api/profile',
      cookie,
      body: { fullName: 'Updated Name' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.profile.fullName, 'Updated Name');

    const again = await server.request({ method: 'GET', path: '/api/profile', cookie });
    assert.equal(again.json.profile.fullName, 'Updated Name');
  });

  it('rejects a blank name', async () => {
    const { cookie } = await signupAndLogin('Has A Name');
    const res = await server.request({ method: 'PATCH', path: '/api/profile', cookie, body: { fullName: '   ' } });
    assert.equal(res.status, 400);
  });

  it('has no email field at all — email is read-only', async () => {
    const { cookie, email } = await signupAndLogin('Immutable Email');
    const res = await server.request({
      method: 'PATCH',
      path: '/api/profile',
      cookie,
      body: { fullName: 'Still Me', email: 'someone-else@example.test' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.profile.email, email, 'a submitted email field is silently ignored');
  });

  it('cannot set role through this endpoint', async () => {
    const { cookie } = await signupAndLogin('Role Spoofer');
    const res = await server.request({
      method: 'PATCH',
      path: '/api/profile',
      cookie,
      body: { fullName: 'Still A Member', role: 'staff' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.profile.role, 'member');
  });
});

describe('POST /api/profile/change-password', () => {
  it('changes the password when the current password is correct', async () => {
    const { cookie, email } = await signupAndLogin('Password Changer', 'original-password-1');
    const res = await server.request({
      method: 'POST',
      path: '/api/profile/change-password',
      cookie,
      body: {
        currentPassword: 'original-password-1',
        newPassword: 'brand-new-password-2',
        confirmNewPassword: 'brand-new-password-2',
      },
    });
    assert.equal(res.status, 200);

    const row = await db('users').where({ email }).first();
    const matchesNew = await verifyPassword('brand-new-password-2', row.password_hash);
    const matchesOld = await verifyPassword('original-password-1', row.password_hash);
    assert.equal(matchesNew, true, 'the stored hash was replaced with the new password');
    assert.equal(matchesOld, false, 'the old password no longer works');

    // The old password stops working at login; the new one works.
    const oldLogin = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email, password: 'original-password-1' },
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email, password: 'brand-new-password-2' },
    });
    assert.equal(newLogin.status, 200);
  });

  it('the current session stays valid immediately after a password change', async () => {
    const { cookie } = await signupAndLogin('Session Continuity', 'original-password-1');
    await server.request({
      method: 'POST',
      path: '/api/profile/change-password',
      cookie,
      body: {
        currentPassword: 'original-password-1',
        newPassword: 'brand-new-password-2',
        confirmNewPassword: 'brand-new-password-2',
      },
    });
    const me = await server.request({ method: 'GET', path: '/api/auth/me', cookie });
    assert.equal(me.status, 200, 'the session cookie used to change the password is still accepted');
  });

  it('rejects an incorrect current password, and does not change the stored hash', async () => {
    const { cookie, email } = await signupAndLogin('Wrong Current', 'original-password-1');
    const res = await server.request({
      method: 'POST',
      path: '/api/profile/change-password',
      cookie,
      body: {
        currentPassword: 'totally-wrong-password',
        newPassword: 'brand-new-password-2',
        confirmNewPassword: 'brand-new-password-2',
      },
    });
    assert.equal(res.status, 401);

    const row = await db('users').where({ email }).first();
    const stillOriginal = await verifyPassword('original-password-1', row.password_hash);
    assert.equal(stillOriginal, true);
  });

  it('rejects a new/confirm mismatch', async () => {
    const { cookie } = await signupAndLogin('Mismatch', 'original-password-1');
    const res = await server.request({
      method: 'POST',
      path: '/api/profile/change-password',
      cookie,
      body: {
        currentPassword: 'original-password-1',
        newPassword: 'brand-new-password-2',
        confirmNewPassword: 'a-completely-different-one',
      },
    });
    assert.equal(res.status, 400);
  });

  it('rejects a weak (too short) new password', async () => {
    const { cookie } = await signupAndLogin('Weak New Password', 'original-password-1');
    const res = await server.request({
      method: 'POST',
      path: '/api/profile/change-password',
      cookie,
      body: { currentPassword: 'original-password-1', newPassword: 'short1', confirmNewPassword: 'short1' },
    });
    assert.equal(res.status, 400);
  });

  it('requires authentication', async () => {
    const res = await server.request({
      method: 'POST',
      path: '/api/profile/change-password',
      body: { currentPassword: 'x', newPassword: 'a-real-password-123', confirmNewPassword: 'a-real-password-123' },
    });
    assert.equal(res.status, 401);
  });
});
