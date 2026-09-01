import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Authentication flow, exercised over real HTTP against a running instance of
 * the app and a live database — not by calling handler functions directly —
 * so this proves the cookie really is set, sent, read and cleared the way a
 * browser would, not just that the right function was called.
 *
 * Requires seeded data (`npm run db:seed` or `db:reset`) with SEED_PASSWORD
 * set to the same value this process has, since the login tests authenticate
 * as real seeded accounts.
 */

let server;
const fixture = {};

before(async () => {
  server = await startTestServer();

  fixture.staff = await db('users')
    .where({ role: 'staff', is_active: true })
    .first();
  fixture.inactiveInstructor = await db('users')
    .where({ role: 'instructor', is_active: false })
    .first();

  assert.ok(
    fixture.staff,
    'seed data is required: run `npm run db:seed` (see backend/.env.example)',
  );
  assert.ok(
    fixture.inactiveInstructor,
    'seed data must include a deactivated instructor',
  );
  assert.ok(
    env.SEED_PASSWORD,
    'SEED_PASSWORD must be set to the value the database was seeded with',
  );
});

after(async () => {
  await server.stop();
  await closeConnection();
});

describe('POST /api/auth/login', () => {
  it('accepts valid credentials, sets an httpOnly session cookie, and never returns the password hash', async () => {
    const res = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: fixture.staff.email, password: env.SEED_PASSWORD },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.user.email, fixture.staff.email);
    assert.equal(res.json.user.role, 'staff');
    assert.equal('password_hash' in res.json.user, false);
    assert.equal('passwordHash' in res.json.user, false);
    assert.doesNotMatch(res.raw, /\$argon2/);

    assert.ok(res.setCookieHeader, 'expected a Set-Cookie header');
    assert.match(res.setCookieHeader, /^session=/);
    assert.match(res.setCookieHeader, /HttpOnly/i);
  });

  it('rejects an email that does not belong to any account', async () => {
    const res = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'nobody-by-this-email@studio.test', password: 'whatever123' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'Invalid email or password.');
    assert.equal(res.cookie, null);
  });

  it('rejects the wrong password for a real account', async () => {
    const res = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: fixture.staff.email, password: 'definitely-the-wrong-password' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'Invalid email or password.');
  });

  it('gives the same response for a wrong email and a wrong password (no user-enumeration signal)', async () => {
    const wrongEmail = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'nobody-by-this-email@studio.test', password: 'whatever123' },
    });
    const wrongPassword = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: fixture.staff.email, password: 'definitely-the-wrong-password' },
    });
    assert.equal(wrongEmail.status, wrongPassword.status);
    assert.equal(wrongEmail.json.error, wrongPassword.json.error);
  });

  it('rejects a correct password for a deactivated account', async () => {
    const res = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: {
        email: fixture.inactiveInstructor.email,
        password: env.SEED_PASSWORD,
      },
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'Invalid email or password.');
    assert.equal(res.cookie, null);
  });

  it('rejects malformed input with 400, not 401 or 500', async () => {
    const missingPassword = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: fixture.staff.email },
    });
    assert.equal(missingPassword.status, 400);

    const notAnEmail = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'not-an-email', password: 'whatever123' },
    });
    assert.equal(notAnEmail.status, 400);

    const emptyBody = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: {},
    });
    assert.equal(emptyBody.status, 400);
  });
});

describe('GET /api/auth/me', () => {
  it('rejects a request with no session cookie', async () => {
    const res = await server.request({ method: 'GET', path: '/api/auth/me' });
    assert.equal(res.status, 401);
  });

  it('rejects a garbage cookie value', async () => {
    const res = await server.request({
      method: 'GET',
      path: '/api/auth/me',
      cookie: 'session=not-a-real-token',
    });
    assert.equal(res.status, 401);
  });

  it('returns the authenticated user for a valid session, never the password hash', async () => {
    const login = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: fixture.staff.email, password: env.SEED_PASSWORD },
    });

    const res = await server.request({
      method: 'GET',
      path: '/api/auth/me',
      cookie: login.cookie,
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.user.email, fixture.staff.email);
    assert.equal('password_hash' in res.json.user, false);
    assert.doesNotMatch(res.raw, /\$argon2/);
  });

  it('resolves identity from the session cookie alone, ignoring an id in the request body', async () => {
    const login = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: fixture.staff.email, password: env.SEED_PASSWORD },
    });

    // A malicious or buggy client claiming to be someone else via the body.
    // The cookie is the only source of identity the server trusts.
    const res = await server.request({
      method: 'GET',
      path: '/api/auth/me',
      cookie: login.cookie,
      body: { id: fixture.inactiveInstructor.id, email: fixture.inactiveInstructor.email },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.user.email, fixture.staff.email);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session cookie and returns 204', async () => {
    const login = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: fixture.staff.email, password: env.SEED_PASSWORD },
    });

    const res = await server.request({
      method: 'POST',
      path: '/api/auth/logout',
      cookie: login.cookie,
    });

    assert.equal(res.status, 204);
    assert.ok(res.setCookieHeader, 'expected logout to clear the cookie');
    assert.match(res.setCookieHeader, /^session=;/);
  });
});
