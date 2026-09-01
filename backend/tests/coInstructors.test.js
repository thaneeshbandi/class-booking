import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Goal 5 — co-instructors: list/add/remove, exercised over real HTTP against
 * a running app and a live database, following the same fixture pattern as
 * `sessions.test.js` — a scratch room and class, and every fixture session
 * scheduled inside a far-future window this suite fully controls.
 *
 * `WINDOW_START` sits well clear of `sessions.test.js`'s own scratch window
 * (`+60` days) even though each file cleans up its own rows in `after()`, so
 * a session created in one file's window is never in scheduling range of a
 * seeded instructor's fixture session created by the other.
 */

let server;
const fixture = {};
const createdSessionIds = [];
const createdClassIds = [];
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

const WINDOW_START = new Date(Date.now() + 120 * 86_400_000);

function at(hoursFromWindowStart) {
  return new Date(WINDOW_START.getTime() + hoursFromWindowStart * 3_600_000);
}

async function createSession(cookie, overrides = {}) {
  const res = await server.request({
    method: 'POST',
    path: '/api/sessions',
    cookie,
    body: {
      classId: fixture.class.id,
      primaryInstructorId: fixture.instructorA.id,
      roomId: fixture.roomA.id,
      startsAt: at(0).toISOString(),
      durationMinutes: 60,
      ...overrides,
    },
  });
  return res;
}

function addCoInstructor(cookie, sessionId, instructorId) {
  return server.request({
    method: 'POST',
    path: `/api/sessions/${sessionId}/co-instructors`,
    cookie,
    body: { instructorId },
  });
}

function removeCoInstructor(cookie, sessionId, instructorId) {
  return server.request({
    method: 'DELETE',
    path: `/api/sessions/${sessionId}/co-instructors/${instructorId}`,
    cookie,
  });
}

function listCoInstructors(cookie, sessionId) {
  return server.request({
    method: 'GET',
    path: `/api/sessions/${sessionId}/co-instructors`,
    cookie,
  });
}

before(async () => {
  server = await startTestServer();

  fixture.staff = await db('users').where({ role: 'staff', is_active: true }).first();
  const instructors = await db('users')
    .where({ role: 'instructor', is_active: true })
    .select('*');
  assert.ok(
    instructors.length >= 3,
    'seed data requires at least three active instructors',
  );
  [fixture.instructorA, fixture.instructorB, fixture.instructorC] = instructors;

  fixture.inactiveInstructor = await db('users')
    .where({ role: 'instructor', is_active: false })
    .first();
  assert.ok(
    fixture.inactiveInstructor,
    'seed data requires at least one inactive instructor',
  );

  // Idempotent cleanup in case a previous run of this suite crashed before
  // its own `after` hook ran — room names are globally unique.
  const stale = await db('rooms').where('name', 'like', 'Co-Instructors Test Room%');
  if (stale.length > 0) {
    const staleIds = stale.map((r) => r.id);
    await db('sessions').whereIn('room_id', staleIds).delete();
    await db('rooms').whereIn('id', staleIds).delete();
  }

  const rooms = await db('rooms')
    .insert([
      { name: 'Co-Instructors Test Room A' },
      { name: 'Co-Instructors Test Room B' },
    ])
    .returning('*');
  [fixture.roomA, fixture.roomB] = rooms;
  createdRoomIds.push(fixture.roomA.id, fixture.roomB.id);

  const staffCookie = await loginAs(fixture.staff);
  const classRes = await server.request({
    method: 'POST',
    path: '/api/classes',
    cookie: staffCookie,
    body: {
      title: 'Co-Instructors Test Class',
      discipline: 'Testing',
      defaultDurationMinutes: 60,
      defaultCapacity: 5,
    },
  });
  assert.equal(classRes.status, 201, classRes.raw);
  fixture.class = classRes.json.class;
  createdClassIds.push(fixture.class.id);
});

after(async () => {
  if (createdSessionIds.length > 0) {
    await db('sessions').whereIn('id', createdSessionIds).delete();
  }
  if (createdClassIds.length > 0) {
    await db('classes').whereIn('id', createdClassIds).delete();
  }
  if (createdRoomIds.length > 0) {
    await db('rooms').whereIn('id', createdRoomIds).delete();
  }
  await server.stop();
  await closeConnection();
});

describe('authorization', () => {
  let session;

  before(async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await createSession(cookie, { startsAt: at(0).toISOString() });
    assert.equal(res.status, 201, res.raw);
    session = res.json.session;
    createdSessionIds.push(session.id);

    const addRes = await addCoInstructor(cookie, session.id, fixture.instructorB.id);
    assert.equal(addRes.status, 201, addRes.raw);
  });

  it('denies an unauthenticated user listing co-instructors', async () => {
    const res = await server.request({
      method: 'GET',
      path: `/api/sessions/${session.id}/co-instructors`,
    });
    assert.equal(res.status, 401);
  });

  it('lets staff list co-instructors', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await listCoInstructors(cookie, session.id);
    assert.equal(res.status, 200, res.raw);
    assert.ok(Array.isArray(res.json.coInstructors));
    assert.ok(
      res.json.coInstructors.some((c) => String(c.id) === String(fixture.instructorB.id)),
    );
  });

  it('lets staff add a co-instructor', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(2).toISOString() });
    assert.equal(created.status, 201, created.raw);
    createdSessionIds.push(created.json.session.id);

    const res = await addCoInstructor(cookie, created.json.session.id, fixture.instructorC.id);
    assert.equal(res.status, 201, res.raw);
    assert.equal(String(res.json.coInstructor.id), String(fixture.instructorC.id));
  });

  it('lets staff remove a co-instructor', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(4).toISOString() });
    assert.equal(created.status, 201, created.raw);
    createdSessionIds.push(created.json.session.id);

    const addRes = await addCoInstructor(cookie, created.json.session.id, fixture.instructorC.id);
    assert.equal(addRes.status, 201, addRes.raw);

    const delRes = await removeCoInstructor(cookie, created.json.session.id, fixture.instructorC.id);
    assert.equal(delRes.status, 204);
  });

  it('denies an instructor adding a co-instructor', async () => {
    const cookie = await loginAs(fixture.instructorA);
    const res = await addCoInstructor(cookie, session.id, fixture.instructorC.id);
    assert.equal(res.status, 403);
  });

  it('denies an instructor removing a co-instructor', async () => {
    const cookie = await loginAs(fixture.instructorA);
    const res = await removeCoInstructor(cookie, session.id, fixture.instructorB.id);
    assert.equal(res.status, 403);
  });

  it("denies an unrelated instructor accessing the session's co-instructor list", async () => {
    const cookie = await loginAs(fixture.instructorC);
    const res = await listCoInstructors(cookie, session.id);
    assert.equal(res.status, 403);
  });

  it('lets the primary instructor and the co-instructor themselves list co-instructors', async () => {
    const primaryCookie = await loginAs(fixture.instructorA);
    const primaryRes = await listCoInstructors(primaryCookie, session.id);
    assert.equal(primaryRes.status, 200, primaryRes.raw);

    const coCookie = await loginAs(fixture.instructorB);
    const coRes = await listCoInstructors(coCookie, session.id);
    assert.equal(coRes.status, 200, coRes.raw);
  });
});

describe('validity', () => {
  it('rejects a malformed session id', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await addCoInstructor(cookie, 'not-an-id', fixture.instructorB.id);
    assert.equal(res.status, 400);
  });

  it('rejects adding a co-instructor to a nonexistent session', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await addCoInstructor(cookie, 999999999, fixture.instructorB.id);
    assert.equal(res.status, 404);
  });

  it('rejects adding a nonexistent instructor', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(10).toISOString() });
    createdSessionIds.push(created.json.session.id);

    const res = await addCoInstructor(cookie, created.json.session.id, 999999999);
    assert.equal(res.status, 400);
  });

  it('rejects adding a staff user as a co-instructor', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(12).toISOString() });
    createdSessionIds.push(created.json.session.id);

    const res = await addCoInstructor(cookie, created.json.session.id, fixture.staff.id);
    assert.equal(res.status, 400);
  });

  it('rejects adding an inactive instructor as a co-instructor', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(14).toISOString() });
    createdSessionIds.push(created.json.session.id);

    const res = await addCoInstructor(cookie, created.json.session.id, fixture.inactiveInstructor.id);
    assert.equal(res.status, 400);
  });

  it("rejects adding the session's own primary instructor as a co-instructor", async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, {
      startsAt: at(16).toISOString(),
      primaryInstructorId: fixture.instructorA.id,
    });
    createdSessionIds.push(created.json.session.id);

    const res = await addCoInstructor(cookie, created.json.session.id, fixture.instructorA.id);
    assert.equal(res.status, 409);
  });

  it('rejects adding the same co-instructor twice', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(18).toISOString() });
    createdSessionIds.push(created.json.session.id);

    const first = await addCoInstructor(cookie, created.json.session.id, fixture.instructorB.id);
    assert.equal(first.status, 201, first.raw);

    const second = await addCoInstructor(cookie, created.json.session.id, fixture.instructorB.id);
    assert.equal(second.status, 409);
  });

  it('removes a co-instructor, and 404s removing an assignment that no longer exists', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(20).toISOString() });
    createdSessionIds.push(created.json.session.id);

    const addRes = await addCoInstructor(cookie, created.json.session.id, fixture.instructorB.id);
    assert.equal(addRes.status, 201, addRes.raw);

    const delRes = await removeCoInstructor(cookie, created.json.session.id, fixture.instructorB.id);
    assert.equal(delRes.status, 204);

    const row = await db('session_co_instructors')
      .where({ session_id: created.json.session.id, user_id: fixture.instructorB.id })
      .first();
    assert.equal(row, undefined);

    const delAgain = await removeCoInstructor(cookie, created.json.session.id, fixture.instructorB.id);
    assert.equal(delAgain.status, 404);
  });

  it('rejects a malformed instructor id on removal', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(22).toISOString() });
    createdSessionIds.push(created.json.session.id);

    const res = await removeCoInstructor(cookie, created.json.session.id, 'not-an-id');
    assert.equal(res.status, 400);
  });
});

describe('conflict detection', () => {
  it('rejects a co-instructor who overlaps another session as its primary instructor', async () => {
    const cookie = await loginAs(fixture.staff);

    // instructorB is the primary of an existing session at [100, 101).
    const busy = await createSession(cookie, {
      startsAt: at(100).toISOString(),
      durationMinutes: 60,
      roomId: fixture.roomB.id,
      primaryInstructorId: fixture.instructorB.id,
    });
    assert.equal(busy.status, 201, busy.raw);
    createdSessionIds.push(busy.json.session.id);

    // A different session, overlapping [100, 101), primary is instructorA.
    const target = await createSession(cookie, {
      startsAt: at(100.5).toISOString(),
      durationMinutes: 60,
      roomId: fixture.roomA.id,
    });
    assert.equal(target.status, 201, target.raw);
    createdSessionIds.push(target.json.session.id);

    const res = await addCoInstructor(cookie, target.json.session.id, fixture.instructorB.id);
    assert.equal(res.status, 409, res.raw);
    assert.equal(res.json.conflict.type, 'instructor');
  });

  it('rejects a co-instructor who overlaps another session as a co-instructor there', async () => {
    const cookie = await loginAs(fixture.staff);

    // instructorB is a co-instructor (not primary) of an existing session at
    // [200, 201).
    const busy = await createSession(cookie, {
      startsAt: at(200).toISOString(),
      durationMinutes: 60,
      roomId: fixture.roomB.id,
      primaryInstructorId: fixture.instructorC.id,
    });
    assert.equal(busy.status, 201, busy.raw);
    createdSessionIds.push(busy.json.session.id);
    const busyAdd = await addCoInstructor(cookie, busy.json.session.id, fixture.instructorB.id);
    assert.equal(busyAdd.status, 201, busyAdd.raw);

    // A different session, overlapping [200, 201).
    const target = await createSession(cookie, {
      startsAt: at(200.5).toISOString(),
      durationMinutes: 60,
      roomId: fixture.roomA.id,
    });
    assert.equal(target.status, 201, target.raw);
    createdSessionIds.push(target.json.session.id);

    const res = await addCoInstructor(cookie, target.json.session.id, fixture.instructorB.id);
    assert.equal(res.status, 409, res.raw);
    assert.equal(res.json.conflict.type, 'instructor');
  });

  it('allows a co-instructor whose schedule does not overlap', async () => {
    const cookie = await loginAs(fixture.staff);

    const busy = await createSession(cookie, {
      startsAt: at(300).toISOString(),
      durationMinutes: 60,
      roomId: fixture.roomB.id,
      primaryInstructorId: fixture.instructorB.id,
    });
    assert.equal(busy.status, 201, busy.raw);
    createdSessionIds.push(busy.json.session.id);

    const target = await createSession(cookie, {
      startsAt: at(303).toISOString(), // well clear of [300, 301)
      durationMinutes: 60,
      roomId: fixture.roomA.id,
    });
    assert.equal(target.status, 201, target.raw);
    createdSessionIds.push(target.json.session.id);

    const res = await addCoInstructor(cookie, target.json.session.id, fixture.instructorB.id);
    assert.equal(res.status, 201, res.raw);
  });

  it('treats a session starting exactly when the co-instructor’s other session ends as non-overlapping', async () => {
    const cookie = await loginAs(fixture.staff);

    // instructorB's own session runs [400, 401).
    const busy = await createSession(cookie, {
      startsAt: at(400).toISOString(),
      durationMinutes: 60,
      roomId: fixture.roomB.id,
      primaryInstructorId: fixture.instructorB.id,
    });
    assert.equal(busy.status, 201, busy.raw);
    createdSessionIds.push(busy.json.session.id);

    // Target session starts exactly at 401 (the boundary).
    const target = await createSession(cookie, {
      startsAt: at(401).toISOString(),
      durationMinutes: 60,
      roomId: fixture.roomA.id,
    });
    assert.equal(target.status, 201, target.raw);
    createdSessionIds.push(target.json.session.id);

    const res = await addCoInstructor(cookie, target.json.session.id, fixture.instructorB.id);
    assert.equal(res.status, 201, res.raw);
  });
});

describe('primary/co-instructor invariant on PATCH /api/sessions/:id', () => {
  it('rejects making an existing co-instructor the primary instructor', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(500).toISOString() });
    createdSessionIds.push(created.json.session.id);

    const addRes = await addCoInstructor(cookie, created.json.session.id, fixture.instructorB.id);
    assert.equal(addRes.status, 201, addRes.raw);

    const patchRes = await server.request({
      method: 'PATCH',
      path: `/api/sessions/${created.json.session.id}`,
      cookie,
      body: { primaryInstructorId: fixture.instructorB.id },
    });
    assert.equal(patchRes.status, 409, patchRes.raw);

    // The co-instructor row must survive the rejected attempt untouched.
    const row = await db('session_co_instructors')
      .where({ session_id: created.json.session.id, user_id: fixture.instructorB.id })
      .first();
    assert.ok(row, 'the co-instructor assignment must not have been silently deleted');
  });

  it('checks the new schedule against every current co-instructor, not only the new primary', async () => {
    const cookie = await loginAs(fixture.staff);

    // instructorB is a co-instructor of `target`. Separately, instructorB is
    // the primary of `busy`, running [520, 521).
    const busy = await createSession(cookie, {
      startsAt: at(520).toISOString(),
      durationMinutes: 60,
      roomId: fixture.roomB.id,
      primaryInstructorId: fixture.instructorB.id,
    });
    assert.equal(busy.status, 201, busy.raw);
    createdSessionIds.push(busy.json.session.id);

    const target = await createSession(cookie, {
      startsAt: at(530).toISOString(),
      durationMinutes: 60,
      roomId: fixture.roomA.id,
      primaryInstructorId: fixture.instructorA.id,
    });
    assert.equal(target.status, 201, target.raw);
    createdSessionIds.push(target.json.session.id);
    const addRes = await addCoInstructor(cookie, target.json.session.id, fixture.instructorB.id);
    assert.equal(addRes.status, 201, addRes.raw);

    // Move `target`'s time to overlap `busy` — instructorA (the primary)
    // has no conflict, but instructorB (a co-instructor) now does.
    const patchRes = await server.request({
      method: 'PATCH',
      path: `/api/sessions/${target.json.session.id}`,
      cookie,
      body: { startsAt: at(520.5).toISOString() },
    });
    assert.equal(patchRes.status, 409, patchRes.raw);
    assert.ok(
      patchRes.json.conflicts.some(
        (c) => c.type === 'instructor' && String(c.instructorId) === String(fixture.instructorB.id),
      ),
    );
  });

  it('keeps existing co-instructor assignments intact when the primary instructor changes to someone new', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, {
      startsAt: at(540).toISOString(),
      primaryInstructorId: fixture.instructorA.id,
    });
    createdSessionIds.push(created.json.session.id);

    const addRes = await addCoInstructor(cookie, created.json.session.id, fixture.instructorB.id);
    assert.equal(addRes.status, 201, addRes.raw);

    const patchRes = await server.request({
      method: 'PATCH',
      path: `/api/sessions/${created.json.session.id}`,
      cookie,
      body: { primaryInstructorId: fixture.instructorC.id },
    });
    assert.equal(patchRes.status, 200, patchRes.raw);
    assert.equal(String(patchRes.json.session.primaryInstructorId), String(fixture.instructorC.id));

    const row = await db('session_co_instructors')
      .where({ session_id: created.json.session.id, user_id: fixture.instructorB.id })
      .first();
    assert.ok(row, 'the co-instructor assignment must survive the primary instructor change');
    assert.equal(
      String(row.session_primary_instructor_id),
      String(fixture.instructorC.id),
      'the denormalised primary on the join row must follow the new primary instructor',
    );
  });
});

describe('immediate authorization effect of removal', () => {
  it('revokes an instructor’s access to a session, and removes it from their session list, the instant they are removed as co-instructor', async () => {
    const staffCookie = await loginAs(fixture.staff);
    const created = await createSession(staffCookie, { startsAt: at(600).toISOString() });
    createdSessionIds.push(created.json.session.id);
    const sessionId = created.json.session.id;

    const addRes = await addCoInstructor(staffCookie, sessionId, fixture.instructorC.id);
    assert.equal(addRes.status, 201, addRes.raw);

    const targetCookie = await loginAs(fixture.instructorC);

    const beforeGet = await server.request({
      method: 'GET',
      path: `/api/sessions/${sessionId}`,
      cookie: targetCookie,
    });
    assert.equal(beforeGet.status, 200, 'sanity check: co-instructor can see the session');

    const beforeList = await server.request({
      method: 'GET',
      path: '/api/sessions',
      cookie: targetCookie,
    });
    assert.ok(
      beforeList.json.sessions.some((s) => String(s.id) === String(sessionId)),
      'sanity check: the session appears in the co-instructor’s own session list',
    );

    const delRes = await removeCoInstructor(staffCookie, sessionId, fixture.instructorC.id);
    assert.equal(delRes.status, 204);

    const afterGet = await server.request({
      method: 'GET',
      path: `/api/sessions/${sessionId}`,
      cookie: targetCookie, // the exact same, still-unexpired session cookie
    });
    assert.equal(afterGet.status, 403);

    const afterList = await server.request({
      method: 'GET',
      path: '/api/sessions',
      cookie: targetCookie,
    });
    assert.equal(
      afterList.json.sessions.some((s) => String(s.id) === String(sessionId)),
      false,
      'the session must disappear from the instructor’s own session list immediately',
    );

    // Guessing/reusing the session id changes nothing: the same URL, same
    // cookie, is denied — access was never cached client- or server-side.
    const guessAgain = await server.request({
      method: 'GET',
      path: `/api/sessions/${sessionId}`,
      cookie: targetCookie,
    });
    assert.equal(guessAgain.status, 403);
  });
});
