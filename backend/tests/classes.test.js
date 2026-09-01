import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Goal 2 — classes, exercised over real HTTP against a running app and a live
 * database. Every class this suite creates is tracked and removed in
 * `after`; sessions created under a scratch class are deleted before the
 * class itself, since `sessions.class_id` is `ON DELETE RESTRICT`.
 */

let server;
const fixture = {};
const createdClassIds = [];
const createdSessionIds = [];

async function loginAs(user) {
  const res = await server.request({
    method: 'POST',
    path: '/api/auth/login',
    body: { email: user.email, password: env.SEED_PASSWORD },
  });
  assert.equal(res.status, 200, `login as ${user.email} must succeed`);
  return res.cookie;
}

function validClassBody(overrides = {}) {
  return {
    title: 'Fixture Class',
    description: 'Created by classes.test.js',
    discipline: 'Testing',
    defaultDurationMinutes: 45,
    defaultCapacity: 8,
    ...overrides,
  };
}

async function createClass(cookie, overrides = {}) {
  const res = await server.request({
    method: 'POST',
    path: '/api/classes',
    cookie,
    body: validClassBody(overrides),
  });
  assert.equal(res.status, 201, `class fixture creation must succeed: ${res.raw}`);
  createdClassIds.push(res.json.class.id);
  return res.json.class;
}

before(async () => {
  server = await startTestServer();

  fixture.staff = await db('users')
    .where({ role: 'staff', is_active: true })
    .first();
  fixture.instructor = await db('users')
    .where({ role: 'instructor', is_active: true })
    .first();
  fixture.room = await db('rooms').first();

  assert.ok(fixture.staff, 'seed data requires an active staff account');
  assert.ok(fixture.instructor, 'seed data requires an active instructor');
  assert.ok(fixture.room, 'seed data requires at least one room');
});

after(async () => {
  if (createdSessionIds.length > 0) {
    await db('sessions').whereIn('id', createdSessionIds).delete();
  }
  if (createdClassIds.length > 0) {
    await db('classes').whereIn('id', createdClassIds).delete();
  }
  await server.stop();
  await closeConnection();
});

describe('authentication', () => {
  it('denies an unauthenticated request to list classes', async () => {
    const res = await server.request({ method: 'GET', path: '/api/classes' });
    assert.equal(res.status, 401);
  });

  it('denies an unauthenticated request to create a class', async () => {
    const res = await server.request({
      method: 'POST',
      path: '/api/classes',
      body: validClassBody(),
    });
    assert.equal(res.status, 401);
  });
});

describe('GET /api/classes and /api/classes/:id', () => {
  it('lets both staff and an instructor list classes', async () => {
    for (const user of [fixture.staff, fixture.instructor]) {
      const cookie = await loginAs(user);
      const res = await server.request({ method: 'GET', path: '/api/classes', cookie });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json.classes));
    }
  });

  it('excludes archived classes by default and includes them with includeArchived=true', async () => {
    const cookie = await loginAs(fixture.staff);
    const archived = await createClass(cookie, { title: 'Archived-by-default fixture' });
    await server.request({
      method: 'POST',
      path: `/api/classes/${archived.id}/archive`,
      cookie,
    });

    const defaultList = await server.request({ method: 'GET', path: '/api/classes', cookie });
    assert.equal(
      defaultList.json.classes.some((c) => c.id === archived.id),
      false,
      'archived class must not appear in the default list',
    );

    const fullList = await server.request({
      method: 'GET',
      path: '/api/classes?includeArchived=true',
      cookie,
    });
    assert.equal(fullList.json.classes.some((c) => c.id === archived.id), true);
  });

  it('returns class detail by id, including an archived one', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createClass(cookie);
    const res = await server.request({
      method: 'GET',
      path: `/api/classes/${created.id}`,
      cookie,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.class.title, created.title);
  });

  it('404s for a class id that does not exist', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'GET',
      path: '/api/classes/999999999',
      cookie,
    });
    assert.equal(res.status, 404);
  });

  it('400s for a malformed class id', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'GET',
      path: '/api/classes/not-a-number',
      cookie,
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/classes', () => {
  it('lets staff create a class with valid fields', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createClass(cookie, {
      title: 'Create Test',
      defaultDurationMinutes: 30,
      defaultCapacity: 5,
    });
    assert.equal(created.title, 'Create Test');
    assert.equal(created.defaultDurationMinutes, 30);
    assert.equal(created.defaultCapacity, 5);
    assert.equal(created.archivedAt, null);

    const row = await db('classes').where({ id: created.id }).first();
    assert.ok(row, 'the class must actually exist in the database');
  });

  it('denies an instructor creating a class', async () => {
    const cookie = await loginAs(fixture.instructor);
    const res = await server.request({
      method: 'POST',
      path: '/api/classes',
      cookie,
      body: validClassBody(),
    });
    assert.equal(res.status, 403);
  });

  it('rejects missing required fields', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'POST',
      path: '/api/classes',
      cookie,
      body: { title: 'No discipline or numbers' },
    });
    assert.equal(res.status, 400);
  });

  it('rejects a non-positive default duration or capacity', async () => {
    const cookie = await loginAs(fixture.staff);
    const zeroDuration = await server.request({
      method: 'POST',
      path: '/api/classes',
      cookie,
      body: validClassBody({ defaultDurationMinutes: 0 }),
    });
    assert.equal(zeroDuration.status, 400);

    const negativeCapacity = await server.request({
      method: 'POST',
      path: '/api/classes',
      cookie,
      body: validClassBody({ defaultCapacity: -1 }),
    });
    assert.equal(negativeCapacity.status, 400);
  });

  it('cannot spoof staff privileges via a body field, a query parameter, or a custom header', async () => {
    const cookie = await loginAs(fixture.instructor);

    const bodySpoof = await server.request({
      method: 'POST',
      path: '/api/classes',
      cookie,
      body: { ...validClassBody(), role: 'staff' },
    });
    assert.equal(bodySpoof.status, 403);

    const querySpoof = await server.request({
      method: 'POST',
      path: '/api/classes?role=staff',
      cookie,
      body: validClassBody(),
    });
    assert.equal(querySpoof.status, 403);

    const headerSpoof = await server.request({
      method: 'POST',
      path: '/api/classes',
      cookie,
      body: validClassBody(),
      headers: { 'X-Role': 'staff', 'X-User-Role': 'staff' },
    });
    assert.equal(headerSpoof.status, 403);
  });
});

describe('PATCH /api/classes/:id', () => {
  it('lets staff update a class', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createClass(cookie);
    const res = await server.request({
      method: 'PATCH',
      path: `/api/classes/${created.id}`,
      cookie,
      body: { title: 'Updated Title', defaultCapacity: 20 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.class.title, 'Updated Title');
    assert.equal(res.json.class.defaultCapacity, 20);
    // Untouched fields survive a partial update.
    assert.equal(res.json.class.discipline, created.discipline);
  });

  it('denies an instructor updating a class', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createClass(cookie);
    const instructorCookie = await loginAs(fixture.instructor);
    const res = await server.request({
      method: 'PATCH',
      path: `/api/classes/${created.id}`,
      cookie: instructorCookie,
      body: { title: 'Should not apply' },
    });
    assert.equal(res.status, 403);
  });

  it('404s when updating a class that does not exist', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'PATCH',
      path: '/api/classes/999999999',
      cookie,
      body: { title: 'Nope' },
    });
    assert.equal(res.status, 404);
  });

  it('400s when no fields are provided', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createClass(cookie);
    const res = await server.request({
      method: 'PATCH',
      path: `/api/classes/${created.id}`,
      cookie,
      body: {},
    });
    assert.equal(res.status, 400);
  });
});

describe('archive and restore', () => {
  it('lets staff archive a class, and the row remains in the database', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createClass(cookie);

    const res = await server.request({
      method: 'POST',
      path: `/api/classes/${created.id}/archive`,
      cookie,
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.class.archivedAt, 'archivedAt must be set');

    const row = await db('classes').where({ id: created.id }).first();
    assert.ok(row, 'archiving must not delete the row');
    assert.ok(row.archived_at, 'archived_at must be set in the database');
  });

  it('is idempotent: archiving an already-archived class is a no-op, not an error', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createClass(cookie);
    const first = await server.request({
      method: 'POST',
      path: `/api/classes/${created.id}/archive`,
      cookie,
    });
    const second = await server.request({
      method: 'POST',
      path: `/api/classes/${created.id}/archive`,
      cookie,
    });
    assert.equal(second.status, 200);
    assert.equal(second.json.class.archivedAt, first.json.class.archivedAt);
  });

  it('denies an instructor archiving a class', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createClass(cookie);
    const instructorCookie = await loginAs(fixture.instructor);
    const res = await server.request({
      method: 'POST',
      path: `/api/classes/${created.id}/archive`,
      cookie: instructorCookie,
    });
    assert.equal(res.status, 403);

    const row = await db('classes').where({ id: created.id }).first();
    assert.equal(row.archived_at, null, 'the class must remain active');
  });

  it('restores an archived class', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createClass(cookie);
    await server.request({
      method: 'POST',
      path: `/api/classes/${created.id}/archive`,
      cookie,
    });
    const res = await server.request({
      method: 'POST',
      path: `/api/classes/${created.id}/restore`,
      cookie,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.class.archivedAt, null);
  });

  it('archiving a class does not delete its sessions', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createClass(cookie, { defaultDurationMinutes: 60, defaultCapacity: 4 });

    const sessionRes = await server.request({
      method: 'POST',
      path: '/api/sessions',
      cookie,
      body: {
        classId: created.id,
        primaryInstructorId: fixture.instructor.id,
        roomId: fixture.room.id,
        startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
    });
    assert.equal(sessionRes.status, 201, `session fixture creation must succeed: ${sessionRes.raw}`);
    createdSessionIds.push(sessionRes.json.session.id);

    await server.request({
      method: 'POST',
      path: `/api/classes/${created.id}/archive`,
      cookie,
    });

    const sessionRow = await db('sessions').where({ id: sessionRes.json.session.id }).first();
    assert.ok(sessionRow, 'the session must still exist after the class is archived');

    // Still visible/usable to the instructor it belongs to, per the
    // authorization model — archiving the class does not revoke it.
    const instructorCookie = await loginAs(fixture.instructor);
    const viewRes = await server.request({
      method: 'GET',
      path: `/api/sessions/${sessionRes.json.session.id}`,
      cookie: instructorCookie,
    });
    assert.equal(viewRes.status, 200);
  });

  it('rejects creating a new session under an archived class', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createClass(cookie);
    await server.request({
      method: 'POST',
      path: `/api/classes/${created.id}/archive`,
      cookie,
    });

    const res = await server.request({
      method: 'POST',
      path: '/api/sessions',
      cookie,
      body: {
        classId: created.id,
        primaryInstructorId: fixture.instructor.id,
        roomId: fixture.room.id,
        startsAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
      },
    });
    assert.equal(res.status, 409);

    const count = await db('sessions').where({ class_id: created.id }).count({ count: '*' });
    assert.equal(Number(count[0].count), 0, 'no session must have been created');
  });
});
