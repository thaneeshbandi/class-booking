import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Public self-service signup (`POST /api/auth/signup`) — exercised over real
 * HTTP, not by calling the handler directly, for the same reason
 * `auth.test.js` does: this proves the cookie is really set the way a
 * browser would see it, not just that the right function ran.
 *
 * The one property every test here ultimately serves is migration
 * `011_user_role_member.js`'s own claim: a signup account can never be
 * created with an elevated role, regardless of what the request asks for.
 */

let server;
const createdEmails = [];

function uniqueEmail(prefix) {
  const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100_000)}@example.test`;
  createdEmails.push(email);
  return email;
}

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await db('users').whereIn('email', createdEmails).del();
  await server.stop();
  await closeConnection();
});

describe('POST /api/auth/signup', () => {
  it('creates a member account, auto-authenticates it, and never returns the password hash', async () => {
    const email = uniqueEmail('signup');
    const res = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'New Member', email, password: 'a-real-password-123' },
    });

    assert.equal(res.status, 201);
    assert.equal(res.json.user.email, email);
    assert.equal(res.json.user.fullName, 'New Member');
    assert.equal(res.json.user.role, 'member');
    assert.equal('password_hash' in res.json.user, false);
    assert.equal('passwordHash' in res.json.user, false);
    assert.doesNotMatch(res.raw, /\$argon2/);

    assert.ok(res.setCookieHeader, 'expected a Set-Cookie header (auto-login)');
    assert.match(res.setCookieHeader, /^session=/);
    assert.match(res.setCookieHeader, /HttpOnly/i);

    // The cookie actually works for the next request, not just present.
    const me = await server.request({ method: 'GET', path: '/api/auth/me', cookie: res.cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.email, email);
  });

  it('ignores a role field in the request body — cannot self-register as staff or instructor', async () => {
    const email = uniqueEmail('signup-role-spoof');
    const res = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'Spoofer', email, password: 'a-real-password-123', role: 'staff' },
    });

    assert.equal(res.status, 201);
    assert.equal(res.json.user.role, 'member');

    const row = await db('users').where({ email }).first();
    assert.equal(row.role, 'member');
  });

  it('normalizes email the same way login/other endpoints do (trim + lowercase)', async () => {
    const base = uniqueEmail('signup-case');
    const email = `  ${base.toUpperCase()}  `;
    const res = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'Case Test', email, password: 'a-real-password-123' },
    });

    assert.equal(res.status, 201);
    assert.equal(res.json.user.email, base.toLowerCase());
  });

  it('rejects a duplicate email with 409, not a raw database error', async () => {
    const email = uniqueEmail('signup-dup');
    const first = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'First', email, password: 'a-real-password-123' },
    });
    assert.equal(first.status, 201);

    const second = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'Second', email, password: 'a-different-password-456' },
    });
    assert.equal(second.status, 409);
    assert.equal(second.json.error, 'An account with this email already exists.');
  });

  it('rejects a duplicate email against an existing seeded staff/instructor account too', async () => {
    const existingStaff = await db('users').where({ role: 'staff' }).first();
    const res = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'Impersonator', email: existingStaff.email, password: 'a-real-password-123' },
    });
    assert.equal(res.status, 409);
  });

  it('rejects a password shorter than 8 characters', async () => {
    const res = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'Short', email: uniqueEmail('signup-short-pw'), password: 'short1' },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /password/i);
  });

  it('rejects a malformed email', async () => {
    const res = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'Bad Email', email: 'not-an-email', password: 'a-real-password-123' },
    });
    assert.equal(res.status, 400);
  });

  it('rejects a missing or blank full name', async () => {
    const missing = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { email: uniqueEmail('signup-no-name'), password: 'a-real-password-123' },
    });
    assert.equal(missing.status, 400);

    const blank = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: '   ', email: uniqueEmail('signup-blank-name'), password: 'a-real-password-123' },
    });
    assert.equal(blank.status, 400);
  });

  it('rejects an empty body with 400, not 500', async () => {
    const res = await server.request({ method: 'POST', path: '/api/auth/signup', body: {} });
    assert.equal(res.status, 400);
  });
});
