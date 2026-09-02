import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * `GET /api/rooms` and `GET /api/users` — added for the frontend milestone,
 * not one of the ten original goals (see `docs/decisions.md`). Both are
 * read-only listings with no create/edit/delete counterpart, so there is
 * nothing state-changing to test beyond authorization and filtering.
 */

let server;
const fixture = {};
const createdRoomIds = [];

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
  fixture.staff = await db('users').where({ role: 'staff', is_active: true }).first();
  fixture.instructor = await db('users').where({ role: 'instructor', is_active: true }).first();
});

after(async () => {
  if (createdRoomIds.length > 0) {
    await db('rooms').whereIn('id', createdRoomIds).delete();
  }
  await server.stop();
  await closeConnection();
});

describe('GET /api/rooms', () => {
  it('lists rooms for staff', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({ method: 'GET', path: '/api/rooms', cookie });
    assert.equal(res.status, 200, res.raw);
    assert.ok(Array.isArray(res.json.rooms));
    assert.ok(res.json.rooms.length > 0);
    assert.match(res.json.rooms[0].id, /^[1-9][0-9]*$/);
  });

  it('lists rooms for an instructor too (read-open to any authenticated user)', async () => {
    const cookie = await loginAs(fixture.instructor);
    const res = await server.request({ method: 'GET', path: '/api/rooms', cookie });
    assert.equal(res.status, 200, res.raw);
    assert.ok(Array.isArray(res.json.rooms));
  });

  it('denies an unauthenticated request', async () => {
    const res = await server.request({ method: 'GET', path: '/api/rooms' });
    assert.equal(res.status, 401);
  });

  it('excludes archived rooms by default, and includes them with includeArchived=true', async () => {
    const cookie = await loginAs(fixture.staff);
    const [room] = await db('rooms')
      .insert({ name: `Rooms Test Archived Room ${Date.now()}`, archived_at: new Date() })
      .returning('*');
    createdRoomIds.push(room.id);

    const defaultList = await server.request({ method: 'GET', path: '/api/rooms', cookie });
    assert.equal(defaultList.status, 200, defaultList.raw);
    assert.equal(
      defaultList.json.rooms.some((r) => r.id === String(room.id)),
      false,
      'an archived room must not appear by default',
    );

    const withArchived = await server.request({
      method: 'GET',
      path: '/api/rooms?includeArchived=true',
      cookie,
    });
    assert.equal(withArchived.status, 200, withArchived.raw);
    assert.ok(
      withArchived.json.rooms.some((r) => r.id === String(room.id)),
      'includeArchived=true must include the archived room',
    );
  });
});

describe('GET /api/users', () => {
  it('lists active instructors for staff when filtered by role', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({ method: 'GET', path: '/api/users?role=instructor', cookie });
    assert.equal(res.status, 200, res.raw);
    assert.ok(res.json.users.length > 0);
    for (const user of res.json.users) {
      assert.equal(user.role, 'instructor');
      assert.match(user.id, /^[1-9][0-9]*$/);
    }
  });

  it('denies an instructor', async () => {
    const cookie = await loginAs(fixture.instructor);
    const res = await server.request({ method: 'GET', path: '/api/users', cookie });
    assert.equal(res.status, 403);
  });

  it('denies an unauthenticated request', async () => {
    const res = await server.request({ method: 'GET', path: '/api/users' });
    assert.equal(res.status, 401);
  });

  it('never lists a deactivated user', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({ method: 'GET', path: '/api/users', cookie });
    assert.equal(res.status, 200, res.raw);
    const ids = res.json.users.map((u) => u.id);
    assert.ok(!ids.includes(undefined));
    // Cross-check directly against the database: every id returned must be
    // an active user there.
    const rows = await db('users').whereIn('id', ids).select('is_active');
    assert.ok(rows.every((r) => r.is_active === true));
  });
});
