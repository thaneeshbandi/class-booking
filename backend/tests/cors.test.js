import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * CORS — added for the frontend milestone (`src/middleware/cors.js`), not
 * one of the ten original goals. The frontend dev server runs on a
 * different origin (port) than the backend, so every browser request is
 * cross-origin; these headers are what makes the httpOnly auth cookie and
 * the attendance CSV's real filename actually reach the browser at all.
 *
 * `Access-Control-Expose-Headers: Content-Disposition` specifically guards
 * against a real bug found during this milestone's own end-to-end
 * verification: without it, a browser's `fetch` cannot read
 * `Content-Disposition` from a cross-origin response even though the header
 * is genuinely present on the wire — `curl` cannot catch this, since it
 * never enforces the browser-side restriction that hides the header.
 */

let server;

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
  await server.stop();
  await closeConnection();
});

describe('CORS', () => {
  it('sets Access-Control-Allow-Origin/Credentials on an ordinary API response', async () => {
    const res = await server.request({ method: 'GET', path: '/health' });
    assert.equal(res.headers['access-control-allow-origin'], env.FRONTEND_ORIGIN);
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
    assert.equal(res.headers.vary, 'Origin');
  });

  it('never allows a wildcard origin, since that is incompatible with credentialed requests', async () => {
    const res = await server.request({ method: 'GET', path: '/health' });
    assert.notEqual(res.headers['access-control-allow-origin'], '*');
  });

  it('answers an OPTIONS preflight with 204 and the expected allow headers', async () => {
    const res = await server.request({ method: 'OPTIONS', path: '/api/auth/login' });
    assert.equal(res.status, 204);
    assert.match(res.headers['access-control-allow-methods'], /POST/);
    assert.match(res.headers['access-control-allow-headers'], /Content-Type/);
  });

  it('exposes Content-Disposition so the browser can read the attendance CSV filename', async () => {
    const staff = await db('users').where({ role: 'staff', is_active: true }).first();
    const cookie = await loginAs(staff);
    const session = await db('sessions').orderBy('id', 'asc').first();
    const res = await server.request({
      method: 'GET',
      path: `/api/sessions/${session.id}/attendance.csv`,
      cookie,
    });
    assert.equal(res.status, 200, res.raw);
    assert.match(res.headers['access-control-expose-headers'] ?? '', /Content-Disposition/);
    assert.ok(res.headers['content-disposition'], 'the response must actually carry the header');
  });
});
