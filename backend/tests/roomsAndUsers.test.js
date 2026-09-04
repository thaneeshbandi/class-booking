import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * `GET /api/rooms`, `GET /api/users`, and `POST /api/users` — none of the
 * three are one of the ten original goals (see `docs/decisions.md`). Rooms
 * and the user listing are read-only with no create/edit/delete
 * counterpart, so there is nothing state-changing to test beyond
 * authorization and filtering. `POST /api/users` (staff creating
 * staff/instructor accounts) does have real state-changing behavior — see
 * its own `describe` block below, which mirrors `tests/members.test.js`'s
 * duplicate-email battery for `routes/members.js`'s `POST /`, since both
 * enforce the same "database-unique email, translated to a clean 409"
 * invariant.
 */

let server;
const fixture = {};
const createdRoomIds = [];
const createdUserIds = [];
const RUN = Date.now();
let counter = 0;

function uniqueEmail(prefix) {
  counter += 1;
  return `${prefix}-${RUN}-${counter}@example.test`;
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
  fixture.staff = await db('users').where({ role: 'staff', is_active: true }).first();
  fixture.instructor = await db('users').where({ role: 'instructor', is_active: true }).first();
});

after(async () => {
  if (createdRoomIds.length > 0) {
    await db('rooms').whereIn('id', createdRoomIds).delete();
  }
  if (createdUserIds.length > 0) {
    await db('users').whereIn('id', createdUserIds).delete();
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

  it('never includes a member account, filtered or not — this is the staff/instructor roster, not every user', async () => {
    const cookie = await loginAs(fixture.staff);
    const memberUser = await db('users').where({ role: 'member' }).first();
    assert.ok(memberUser, 'the seeded/test database must have at least one member account for this to be a real check');

    const unfiltered = await server.request({ method: 'GET', path: '/api/users', cookie });
    assert.equal(unfiltered.status, 200, unfiltered.raw);
    assert.ok(
      unfiltered.json.users.every((u) => u.role !== 'member'),
      'an unfiltered request must never return a member row',
    );
    assert.ok(
      !unfiltered.json.users.some((u) => u.id === String(memberUser.id)),
      'this specific member account must not appear in the listing',
    );
  });
});

describe('POST /api/users', () => {
  function validUserBody(overrides = {}) {
    return {
      fullName: 'New Team Member',
      email: uniqueEmail('team'),
      role: 'instructor',
      password: 'a-real-password-123',
      ...overrides,
    };
  }

  it('staff can create a new instructor account, which can immediately log in', async () => {
    const cookie = await loginAs(fixture.staff);
    const body = validUserBody({ fullName: 'Nina Instructor', role: 'instructor' });
    const res = await server.request({ method: 'POST', path: '/api/users', cookie, body });
    assert.equal(res.status, 201, res.raw);
    createdUserIds.push(res.json.user.id);
    assert.equal(res.json.user.fullName, 'Nina Instructor');
    assert.equal(res.json.user.role, 'instructor');
    assert.equal(res.json.user.password, undefined, 'the password hash is never returned');

    const login = await server.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: body.email, password: body.password },
    });
    assert.equal(login.status, 200, login.raw);
    assert.equal(login.json.user.role, 'instructor');
  });

  it('staff can create a new staff account', async () => {
    const cookie = await loginAs(fixture.staff);
    const body = validUserBody({ fullName: 'Nora Staff', role: 'staff' });
    const res = await server.request({ method: 'POST', path: '/api/users', cookie, body });
    assert.equal(res.status, 201, res.raw);
    createdUserIds.push(res.json.user.id);
    assert.equal(res.json.user.role, 'staff');
  });

  it('rejects a role of "member" — this endpoint can never mint a self-signup-only role', async () => {
    const cookie = await loginAs(fixture.staff);
    const email = uniqueEmail('rejected-member-role');
    const res = await server.request({
      method: 'POST',
      path: '/api/users',
      cookie,
      body: validUserBody({ role: 'member', email }),
    });
    assert.equal(res.status, 400, res.raw);
    const created = await db('users').where({ email });
    assert.equal(created.length, 0, 'no row was created for the rejected request');
  });

  it('rejects a password shorter than 8 characters', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'POST',
      path: '/api/users',
      cookie,
      body: validUserBody({ password: 'short' }),
    });
    assert.equal(res.status, 400, res.raw);
  });

  it('rejects creating an account with an email that already exists', async () => {
    const cookie = await loginAs(fixture.staff);
    const email = uniqueEmail('dup-team');
    const first = await server.request({
      method: 'POST',
      path: '/api/users',
      cookie,
      body: validUserBody({ email }),
    });
    assert.equal(first.status, 201, first.raw);
    createdUserIds.push(first.json.user.id);

    const second = await server.request({
      method: 'POST',
      path: '/api/users',
      cookie,
      body: validUserBody({ email, fullName: 'Someone Else' }),
    });
    assert.equal(second.status, 409, second.raw);
    assert.equal(second.json.error, 'An account with this email already exists.');
    assert.doesNotMatch(second.raw, /SQLSTATE|duplicate key value|constraint/i, 'never a raw database error');

    const matches = await db('users').where({ email });
    assert.equal(matches.length, 1, 'no duplicate row was created');
  });

  it('duplicate detection is case-insensitive and ignores surrounding whitespace', async () => {
    const cookie = await loginAs(fixture.staff);
    const email = uniqueEmail('case-team');
    const first = await server.request({
      method: 'POST',
      path: '/api/users',
      cookie,
      body: validUserBody({ email }),
    });
    assert.equal(first.status, 201, first.raw);
    createdUserIds.push(first.json.user.id);

    const res = await server.request({
      method: 'POST',
      path: '/api/users',
      cookie,
      body: validUserBody({ email: `  ${email.toUpperCase()}  ` }),
    });
    assert.equal(res.status, 409, res.raw);
    assert.equal(res.json.error, 'An account with this email already exists.');
  });

  it('rejects a duplicate email against an existing seeded staff/instructor account too', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'POST',
      path: '/api/users',
      cookie,
      body: validUserBody({ email: fixture.staff.email }),
    });
    assert.equal(res.status, 409, res.raw);
  });

  it('denies an instructor', async () => {
    const cookie = await loginAs(fixture.instructor);
    const res = await server.request({
      method: 'POST',
      path: '/api/users',
      cookie,
      body: validUserBody(),
    });
    assert.equal(res.status, 403);
  });

  it('denies an unauthenticated request', async () => {
    const res = await server.request({ method: 'POST', path: '/api/users', body: validUserBody() });
    assert.equal(res.status, 401);
  });
});
