import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Authorization: role checks, resource-level instructor ownership, and
 * server-side collection scoping. Run over real HTTP against a running app
 * and a live database, using real seeded accounts and real
 * `session_co_instructors` rows — not mocked role checks — because the thing
 * under test is exactly whether the SQL and the middleware, together, produce
 * the right access decision against current database state.
 *
 * Requires seeded data (`npm run db:seed` or `db:reset`) with at least three
 * distinct active instructors and one existing co-instructor assignment, and
 * SEED_PASSWORD set to the value the database was seeded with.
 */

let server;
const fixture = {};

async function loginAs(user) {
  const res = await server.request({
    method: 'POST',
    path: '/api/auth/login',
    body: { email: user.email, password: env.SEED_PASSWORD },
  });
  assert.equal(res.status, 200, `login as ${user.email} must succeed`);
  return res.cookie;
}

/** Independent oracle for instructor session-visibility, not sharing code
 * with `scopeSessionsToInstructor` — otherwise a bug in that helper would
 * pass its own test. */
async function expectedSessionIds(user) {
  if (user.role === 'staff') {
    const rows = await db('sessions').select('id');
    return new Set(rows.map((r) => String(r.id)));
  }
  const { rows } = await db.raw(
    `SELECT id FROM sessions
      WHERE primary_instructor_id = ?
         OR id IN (SELECT session_id FROM session_co_instructors WHERE user_id = ?)`,
    [user.id, user.id],
  );
  return new Set(rows.map((r) => String(r.id)));
}

async function expectedBookingIds(user) {
  if (user.role === 'staff') {
    const rows = await db('bookings').select('id');
    return new Set(rows.map((r) => String(r.id)));
  }
  const { rows } = await db.raw(
    `SELECT b.id FROM bookings b
       JOIN sessions s ON s.id = b.session_id
      WHERE s.primary_instructor_id = ?
         OR s.id IN (SELECT session_id FROM session_co_instructors WHERE user_id = ?)`,
    [user.id, user.id],
  );
  return new Set(rows.map((r) => String(r.id)));
}

before(async () => {
  server = await startTestServer();

  fixture.staff = await db('users')
    .where({ role: 'staff', is_active: true })
    .first();

  const coRow = await db('session_co_instructors').first();
  assert.ok(
    coRow,
    'seed data must include at least one co-instructor assignment',
  );

  fixture.sessionId = coRow.session_id;
  fixture.primaryInstructor = await db('users')
    .where({ id: coRow.session_primary_instructor_id })
    .first();
  fixture.coInstructor = await db('users').where({ id: coRow.user_id }).first();

  const coInstructorRowsForSession = await db('session_co_instructors')
    .where({ session_id: coRow.session_id })
    .select('user_id');
  const relatedIds = new Set([
    coRow.session_primary_instructor_id,
    ...coInstructorRowsForSession.map((r) => r.user_id),
  ]);

  fixture.unrelatedInstructor = await db('users')
    .where({ role: 'instructor', is_active: true })
    .whereNotIn('id', [...relatedIds])
    .first();

  assert.ok(fixture.staff, 'seed data requires an active staff account');
  assert.ok(
    fixture.unrelatedInstructor,
    'seed data requires a third instructor unrelated to the co-instructed session',
  );

  fixture.unrelatedInstructorOwnSession = await db('sessions')
    .where({ primary_instructor_id: fixture.unrelatedInstructor.id })
    .first();
  assert.ok(
    fixture.unrelatedInstructorOwnSession,
    'the unrelated instructor fixture must have a session of their own',
  );
});

after(async () => {
  await server.stop();
  await closeConnection();
});

describe('staff-only endpoints', () => {
  it('lets staff access a staff-only endpoint', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'GET',
      path: '/api/members',
      cookie,
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.members));
  });

  it('denies an instructor the same staff-only endpoint', async () => {
    const cookie = await loginAs(fixture.primaryInstructor);
    const res = await server.request({
      method: 'GET',
      path: '/api/members',
      cookie,
    });
    assert.equal(res.status, 403);
  });

  it('denies access with no session at all (deny by default)', async () => {
    const res = await server.request({ method: 'GET', path: '/api/members' });
    assert.equal(res.status, 401);
  });
});

describe('instructor ownership of a single session', () => {
  it('lets the primary instructor access their session', async () => {
    const cookie = await loginAs(fixture.primaryInstructor);
    const res = await server.request({
      method: 'GET',
      path: `/api/sessions/${fixture.sessionId}`,
      cookie,
    });
    assert.equal(res.status, 200);
    assert.equal(String(res.json.session.id), String(fixture.sessionId));
  });

  it('lets a co-instructor access the same session', async () => {
    const cookie = await loginAs(fixture.coInstructor);
    const res = await server.request({
      method: 'GET',
      path: `/api/sessions/${fixture.sessionId}`,
      cookie,
    });
    assert.equal(res.status, 200);
  });

  it('denies an unrelated instructor', async () => {
    const cookie = await loginAs(fixture.unrelatedInstructor);
    const res = await server.request({
      method: 'GET',
      path: `/api/sessions/${fixture.sessionId}`,
      cookie,
    });
    assert.equal(res.status, 403);
  });

  it('lets staff access any session regardless of who teaches it', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'GET',
      path: `/api/sessions/${fixture.sessionId}`,
      cookie,
    });
    assert.equal(res.status, 200);
  });

  it('404s for a session id that does not exist, for staff and instructor alike', async () => {
    const staffCookie = await loginAs(fixture.staff);
    const staffRes = await server.request({
      method: 'GET',
      path: '/api/sessions/999999999',
      cookie: staffCookie,
    });
    assert.equal(staffRes.status, 404);

    const instructorCookie = await loginAs(fixture.primaryInstructor);
    const instructorRes = await server.request({
      method: 'GET',
      path: '/api/sessions/999999999',
      cookie: instructorCookie,
    });
    assert.equal(instructorRes.status, 404);
  });

  it('cannot be bypassed by changing the session id in the URL to one they do not own', async () => {
    const cookie = await loginAs(fixture.unrelatedInstructor);

    const ownSession = await server.request({
      method: 'GET',
      path: `/api/sessions/${fixture.unrelatedInstructorOwnSession.id}`,
      cookie,
    });
    assert.equal(ownSession.status, 200, 'sanity check: they can see their own session');

    const someoneElsesSession = await server.request({
      method: 'GET',
      path: `/api/sessions/${fixture.sessionId}`,
      cookie,
    });
    assert.equal(someoneElsesSession.status, 403);
  });

  it('cannot be bypassed by putting a session id they own in the request body', async () => {
    const cookie = await loginAs(fixture.unrelatedInstructor);

    // The URL names a session they are not authorized for. The body claims
    // one they are. Only req.params may ever decide this.
    const res = await server.request({
      method: 'GET',
      path: `/api/sessions/${fixture.sessionId}`,
      cookie,
      body: { sessionId: fixture.unrelatedInstructorOwnSession.id },
    });
    assert.equal(res.status, 403);
  });

  it('revokes access immediately when a co-instructor assignment is removed', async () => {
    const cookie = await loginAs(fixture.unrelatedInstructor);

    await db('session_co_instructors').insert({
      session_id: fixture.sessionId,
      user_id: fixture.unrelatedInstructor.id,
      session_primary_instructor_id: fixture.primaryInstructor.id,
    });

    try {
      const whileCoInstructor = await server.request({
        method: 'GET',
        path: `/api/sessions/${fixture.sessionId}`,
        cookie,
      });
      assert.equal(whileCoInstructor.status, 200);

      await db('session_co_instructors')
        .where({ session_id: fixture.sessionId, user_id: fixture.unrelatedInstructor.id })
        .delete();

      const afterRemoval = await server.request({
        method: 'GET',
        path: `/api/sessions/${fixture.sessionId}`,
        cookie, // the exact same, still-unexpired session cookie
      });
      assert.equal(afterRemoval.status, 403);
    } finally {
      // Make the test idempotent even if an assertion above throws.
      await db('session_co_instructors')
        .where({ session_id: fixture.sessionId, user_id: fixture.unrelatedInstructor.id })
        .delete();
    }
  });
});

describe('a session\'s booking list', () => {
  it('is visible to the primary instructor and denied to an unrelated one', async () => {
    const ownerCookie = await loginAs(fixture.primaryInstructor);
    const ownerRes = await server.request({
      method: 'GET',
      path: `/api/sessions/${fixture.sessionId}/bookings`,
      cookie: ownerCookie,
    });
    assert.equal(ownerRes.status, 200);
    assert.ok(Array.isArray(ownerRes.json.bookings));

    const unrelatedCookie = await loginAs(fixture.unrelatedInstructor);
    const unrelatedRes = await server.request({
      method: 'GET',
      path: `/api/sessions/${fixture.sessionId}/bookings`,
      cookie: unrelatedCookie,
    });
    assert.equal(unrelatedRes.status, 403);
  });
});

describe('collection authorization: GET /api/sessions', () => {
  it('scopes results to exactly what each caller is authorized to see, computed in SQL', async () => {
    for (const user of [
      fixture.staff,
      fixture.primaryInstructor,
      fixture.coInstructor,
      fixture.unrelatedInstructor,
    ]) {
      const cookie = await loginAs(user);
      const res = await server.request({ method: 'GET', path: '/api/sessions', cookie });
      assert.equal(res.status, 200);

      const returnedIds = new Set(res.json.sessions.map((s) => String(s.id)));
      const expected = await expectedSessionIds(user);
      assert.deepEqual(
        returnedIds,
        expected,
        `session list for ${user.email} did not match the independently-computed expected set`,
      );
    }
  });

  it('never lets the unrelated instructor see the co-instructed session', async () => {
    const cookie = await loginAs(fixture.unrelatedInstructor);
    const res = await server.request({ method: 'GET', path: '/api/sessions', cookie });
    const returnedIds = res.json.sessions.map((s) => String(s.id));
    assert.equal(returnedIds.includes(String(fixture.sessionId)), false);
  });
});

describe('collection authorization: GET /api/bookings', () => {
  it('scopes results to exactly what each caller is authorized to see, computed in SQL', async () => {
    for (const user of [
      fixture.staff,
      fixture.primaryInstructor,
      fixture.coInstructor,
      fixture.unrelatedInstructor,
    ]) {
      const cookie = await loginAs(user);
      const res = await server.request({ method: 'GET', path: '/api/bookings', cookie });
      assert.equal(res.status, 200);

      const returnedIds = new Set(res.json.bookings.map((b) => String(b.id)));
      const expected = await expectedBookingIds(user);
      assert.deepEqual(
        returnedIds,
        expected,
        `booking list for ${user.email} did not match the independently-computed expected set`,
      );
    }
  });
});
