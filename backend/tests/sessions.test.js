import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Goal 3 — sessions: creation, editing, deletion, and the server-side
 * conflict rules, exercised over real HTTP against a running app and a live
 * database.
 *
 * Fixture rooms and a fixture class are created once (and torn down in
 * `after`) so every conflict scenario runs in a scheduling window this suite
 * fully controls, rather than reasoning about what the seed happens to
 * contain.
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

/** Every fixture session in this suite is scheduled inside this far-future
 * window, well clear of anything the seed created. */
const WINDOW_START = new Date(Date.now() + 60 * 86_400_000);

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

before(async () => {
  server = await startTestServer();

  fixture.staff = await db('users')
    .where({ role: 'staff', is_active: true })
    .first();
  const instructors = await db('users')
    .where({ role: 'instructor', is_active: true })
    .select('*');
  assert.ok(
    instructors.length >= 3,
    'seed data requires at least three active instructors',
  );
  [fixture.instructorA, fixture.instructorB, fixture.instructorC] = instructors;

  // Idempotent cleanup in case a previous run of this suite crashed before
  // its own `after` hook ran — room names are globally unique.
  const stale = await db('rooms').where('name', 'like', 'Sessions Test Room%');
  if (stale.length > 0) {
    const staleIds = stale.map((r) => r.id);
    await db('sessions').whereIn('room_id', staleIds).delete();
    await db('rooms').whereIn('id', staleIds).delete();
  }

  const rooms = await db('rooms')
    .insert([{ name: 'Sessions Test Room A' }, { name: 'Sessions Test Room B' }])
    .returning('*');
  [fixture.roomA, fixture.roomB] = rooms;
  createdRoomIds.push(fixture.roomA.id, fixture.roomB.id);

  const staffCookie = await loginAs(fixture.staff);
  const classRes = await server.request({
    method: 'POST',
    path: '/api/classes',
    cookie: staffCookie,
    body: {
      title: 'Sessions Test Class',
      discipline: 'Testing',
      defaultDurationMinutes: 60,
      defaultCapacity: 5,
    },
  });
  assert.equal(classRes.status, 201);
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

describe('POST /api/sessions — creation', () => {
  it('lets staff create a session, defaulting duration and capacity from the class', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await createSession(cookie, {
      startsAt: at(0).toISOString(),
      durationMinutes: undefined,
    });
    assert.equal(res.status, 201, res.raw);
    createdSessionIds.push(res.json.session.id);
    assert.equal(res.json.session.durationMinutes, fixture.class.defaultDurationMinutes);
    assert.equal(res.json.session.capacity, fixture.class.defaultCapacity);
    assert.equal(
      new Date(res.json.session.endsAt).getTime(),
      new Date(res.json.session.startsAt).getTime() +
        fixture.class.defaultDurationMinutes * 60_000,
    );
  });

  it('lets staff override duration and capacity per session', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await createSession(cookie, {
      startsAt: at(2).toISOString(),
      durationMinutes: 45,
      capacity: 3,
    });
    assert.equal(res.status, 201, res.raw);
    createdSessionIds.push(res.json.session.id);
    assert.equal(res.json.session.durationMinutes, 45);
    assert.equal(res.json.session.capacity, 3);
  });

  it('denies an instructor creating a session', async () => {
    const cookie = await loginAs(fixture.instructorA);
    const res = await createSession(cookie, { startsAt: at(4).toISOString() });
    assert.equal(res.status, 403);
  });

  it('denies an unauthenticated request', async () => {
    const res = await server.request({
      method: 'POST',
      path: '/api/sessions',
      body: {
        classId: fixture.class.id,
        primaryInstructorId: fixture.instructorA.id,
        roomId: fixture.roomA.id,
        startsAt: at(4).toISOString(),
      },
    });
    assert.equal(res.status, 401);
  });

  describe('validation', () => {
    it('rejects missing required fields', async () => {
      const cookie = await loginAs(fixture.staff);
      const res = await server.request({
        method: 'POST',
        path: '/api/sessions',
        cookie,
        body: { classId: fixture.class.id },
      });
      assert.equal(res.status, 400);
    });

    it('rejects a malformed startsAt', async () => {
      const cookie = await loginAs(fixture.staff);
      const res = await createSession(cookie, { startsAt: 'not-a-real-date' });
      assert.equal(res.status, 400);
    });

    it('rejects a non-positive duration or capacity', async () => {
      const cookie = await loginAs(fixture.staff);
      const zeroDuration = await createSession(cookie, {
        startsAt: at(6).toISOString(),
        durationMinutes: 0,
      });
      assert.equal(zeroDuration.status, 400);

      const negativeCapacity = await createSession(cookie, {
        startsAt: at(6).toISOString(),
        capacity: -5,
      });
      assert.equal(negativeCapacity.status, 400);
    });

    it('rejects an invalid class id', async () => {
      const cookie = await loginAs(fixture.staff);
      const res = await createSession(cookie, {
        classId: 999999999,
        startsAt: at(8).toISOString(),
      });
      assert.equal(res.status, 400);
    });

    it('rejects an invalid room id', async () => {
      const cookie = await loginAs(fixture.staff);
      const res = await createSession(cookie, {
        roomId: 999999999,
        startsAt: at(8).toISOString(),
      });
      assert.equal(res.status, 400);
    });

    it('rejects an invalid primary instructor id, including a real staff account', async () => {
      const cookie = await loginAs(fixture.staff);
      const nonExistent = await createSession(cookie, {
        primaryInstructorId: 999999999,
        startsAt: at(8).toISOString(),
      });
      assert.equal(nonExistent.status, 400);

      const staffAsInstructor = await createSession(cookie, {
        primaryInstructorId: fixture.staff.id,
        startsAt: at(8).toISOString(),
      });
      assert.equal(staffAsInstructor.status, 400);
    });

    it('cannot spoof a staff role via body field, query parameter, or custom header', async () => {
      const cookie = await loginAs(fixture.instructorA);

      const bodySpoof = await createSession(cookie, {
        startsAt: at(10).toISOString(),
        role: 'staff',
      });
      assert.equal(bodySpoof.status, 403);

      const querySpoof = await server.request({
        method: 'POST',
        path: '/api/sessions?role=staff',
        cookie,
        body: {
          classId: fixture.class.id,
          primaryInstructorId: fixture.instructorA.id,
          roomId: fixture.roomA.id,
          startsAt: at(10).toISOString(),
        },
      });
      assert.equal(querySpoof.status, 403);

      const headerSpoof = await server.request({
        method: 'POST',
        path: '/api/sessions',
        cookie,
        headers: { 'X-Role': 'staff' },
        body: {
          classId: fixture.class.id,
          primaryInstructorId: fixture.instructorA.id,
          roomId: fixture.roomA.id,
          startsAt: at(10).toISOString(),
        },
      });
      assert.equal(headerSpoof.status, 403);
    });
  });

  describe('conflict detection', () => {
    let existingSession;
    let coInstructedSession;

    before(async () => {
      const cookie = await loginAs(fixture.staff);

      const res = await createSession(cookie, {
        startsAt: at(100).toISOString(),
        durationMinutes: 60,
      });
      assert.equal(res.status, 201, res.raw);
      existingSession = res.json.session;
      createdSessionIds.push(existingSession.id);

      // A second existing session, elsewhere, where instructorB is only a
      // co-instructor — this is what proves "co-instructors also count as
      // instructor conflicts" without goal 5's assignment endpoint existing.
      const coRes = await createSession(cookie, {
        startsAt: at(200).toISOString(),
        durationMinutes: 60,
        roomId: fixture.roomB.id,
        primaryInstructorId: fixture.instructorC.id,
      });
      assert.equal(coRes.status, 201, coRes.raw);
      coInstructedSession = coRes.json.session;
      createdSessionIds.push(coInstructedSession.id);
      await db('session_co_instructors').insert({
        session_id: coInstructedSession.id,
        user_id: fixture.instructorB.id,
        session_primary_instructor_id: fixture.instructorC.id,
      });
    });

    it('rejects a new session that overlaps in the same room', async () => {
      const cookie = await loginAs(fixture.staff);
      const res = await createSession(cookie, {
        startsAt: at(100.5).toISOString(), // overlaps [100, 101)
        durationMinutes: 60,
        primaryInstructorId: fixture.instructorB.id, // different instructor, room still conflicts
      });
      assert.equal(res.status, 409);
      assert.ok(res.json.conflicts.some((c) => c.type === 'room'));
    });

    it('rejects a new session where the primary instructor overlaps an existing session as its primary', async () => {
      const cookie = await loginAs(fixture.staff);
      const res = await createSession(cookie, {
        startsAt: at(100.5).toISOString(),
        durationMinutes: 60,
        roomId: fixture.roomB.id, // different room, instructor still conflicts
      });
      assert.equal(res.status, 409);
      assert.ok(res.json.conflicts.some((c) => c.type === 'instructor'));
    });

    it('rejects a new session whose primary instructor overlaps an existing session as a co-instructor', async () => {
      const cookie = await loginAs(fixture.staff);
      const res = await createSession(cookie, {
        startsAt: at(200.5).toISOString(), // overlaps coInstructedSession's [200, 201)
        durationMinutes: 60,
        roomId: fixture.roomA.id, // different room
        primaryInstructorId: fixture.instructorB.id, // co-instructor on coInstructedSession
      });
      assert.equal(res.status, 409);
      assert.ok(res.json.conflicts.some((c) => c.type === 'instructor'));
    });

    it('allows a non-overlapping session in the same room and with the same instructor', async () => {
      const cookie = await loginAs(fixture.staff);
      const res = await createSession(cookie, {
        startsAt: at(103).toISOString(), // well clear of [100, 101)
        durationMinutes: 60,
      });
      assert.equal(res.status, 201, res.raw);
      createdSessionIds.push(res.json.session.id);
    });

    it('treats a session starting exactly when another ends as non-overlapping', async () => {
      const cookie = await loginAs(fixture.staff);
      // existingSession runs [100, 101) in roomA with instructorA.
      const res = await createSession(cookie, {
        startsAt: at(101).toISOString(),
        durationMinutes: 60,
      });
      assert.equal(res.status, 201, res.raw);
      createdSessionIds.push(res.json.session.id);
    });
  });

  it('rejects creating a session for an archived class', async () => {
    const cookie = await loginAs(fixture.staff);
    const classRes = await server.request({
      method: 'POST',
      path: '/api/classes',
      cookie,
      body: {
        title: 'Archived Before Session Attempt',
        discipline: 'Testing',
        defaultDurationMinutes: 30,
        defaultCapacity: 4,
      },
    });
    createdClassIds.push(classRes.json.class.id);
    await server.request({
      method: 'POST',
      path: `/api/classes/${classRes.json.class.id}/archive`,
      cookie,
    });

    const res = await createSession(cookie, {
      classId: classRes.json.class.id,
      startsAt: at(300).toISOString(),
    });
    assert.equal(res.status, 409);
  });
});

describe('GET /api/sessions — collection scoping with a classId filter', () => {
  it('narrows the list to the given class while still respecting instructor scoping', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await createSession(cookie, { startsAt: at(400).toISOString() });
    assert.equal(res.status, 201, res.raw);
    createdSessionIds.push(res.json.session.id);

    const staffList = await server.request({
      method: 'GET',
      path: `/api/sessions?classId=${fixture.class.id}`,
      cookie,
    });
    assert.equal(staffList.status, 200);
    assert.ok(staffList.json.sessions.every((s) => s.classId === String(fixture.class.id)));
    assert.ok(staffList.json.sessions.some((s) => s.id === res.json.session.id));

    const unrelatedCookie = await loginAs(fixture.instructorC);
    const unrelatedList = await server.request({
      method: 'GET',
      path: `/api/sessions?classId=${fixture.class.id}`,
      cookie: unrelatedCookie,
    });
    assert.equal(unrelatedList.status, 200);
    assert.equal(
      unrelatedList.json.sessions.some((s) => s.id === res.json.session.id),
      false,
      'a session must not be visible through the classId filter to an instructor who is not assigned to it',
    );
  });
});

describe('PATCH /api/sessions/:id', () => {
  it('lets staff update a session', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(500).toISOString() });
    createdSessionIds.push(created.json.session.id);

    const res = await server.request({
      method: 'PATCH',
      path: `/api/sessions/${created.json.session.id}`,
      cookie,
      body: { capacity: 2 },
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.session.capacity, 2);
  });

  it('does not falsely conflict with itself when the update does not change scheduling', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(502).toISOString() });
    createdSessionIds.push(created.json.session.id);

    const res = await server.request({
      method: 'PATCH',
      path: `/api/sessions/${created.json.session.id}`,
      cookie,
      body: { startsAt: created.json.session.startsAt },
    });
    assert.equal(res.status, 200, res.raw);
  });

  it('rejects an update that would newly conflict with a different existing session', async () => {
    const cookie = await loginAs(fixture.staff);
    const first = await createSession(cookie, { startsAt: at(504).toISOString() });
    createdSessionIds.push(first.json.session.id);
    const second = await createSession(cookie, { startsAt: at(510).toISOString() });
    createdSessionIds.push(second.json.session.id);

    const res = await server.request({
      method: 'PATCH',
      path: `/api/sessions/${second.json.session.id}`,
      cookie,
      body: { startsAt: at(504.5).toISOString() },
    });
    assert.equal(res.status, 409);
  });

  it('rejects an invalid room or instructor id on update', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(520).toISOString() });
    createdSessionIds.push(created.json.session.id);

    const badRoom = await server.request({
      method: 'PATCH',
      path: `/api/sessions/${created.json.session.id}`,
      cookie,
      body: { roomId: 999999999 },
    });
    assert.equal(badRoom.status, 400);

    const badInstructor = await server.request({
      method: 'PATCH',
      path: `/api/sessions/${created.json.session.id}`,
      cookie,
      body: { primaryInstructorId: fixture.staff.id },
    });
    assert.equal(badInstructor.status, 400);
  });

  it('404s for a session id that does not exist', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'PATCH',
      path: '/api/sessions/999999999',
      cookie,
      body: { capacity: 1 },
    });
    assert.equal(res.status, 404);
  });

  it('400s when no fields are provided', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(522).toISOString() });
    createdSessionIds.push(created.json.session.id);
    const res = await server.request({
      method: 'PATCH',
      path: `/api/sessions/${created.json.session.id}`,
      cookie,
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('denies an instructor editing any session, including one they are the primary instructor of', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, {
      startsAt: at(524).toISOString(),
      primaryInstructorId: fixture.instructorA.id,
    });
    createdSessionIds.push(created.json.session.id);

    const instructorCookie = await loginAs(fixture.instructorA);
    const res = await server.request({
      method: 'PATCH',
      path: `/api/sessions/${created.json.session.id}`,
      cookie: instructorCookie,
      body: { capacity: 1 },
    });
    assert.equal(res.status, 403);
  });
});

describe('DELETE /api/sessions/:id', () => {
  it('lets staff delete a session with no bookings', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(600).toISOString() });

    const res = await server.request({
      method: 'DELETE',
      path: `/api/sessions/${created.json.session.id}`,
      cookie,
    });
    assert.equal(res.status, 204);

    const row = await db('sessions').where({ id: created.json.session.id }).first();
    assert.equal(row, undefined);
  });

  it('rejects deleting a session that has bookings', async () => {
    const cookie = await loginAs(fixture.staff);

    // Once a real booking is attached, this session becomes permanently
    // undeletable — `bookings.session_id` is `ON DELETE RESTRICT` and
    // `booking_events` is append-only — which is exactly the guarantee this
    // test proves. It therefore gets its own throwaway class and room rather
    // than the shared suite fixtures, so this one test's permanent footprint
    // can never block `after()` from cleaning up everything else. The
    // session row is inserted directly rather than through the conflict-
    // checked POST endpoint: this test is about deletion being blocked by a
    // booking, not scheduling, and a directly-inserted row can never collide
    // with a leftover permanent fixture from an earlier run of this same
    // test the way a `Date.now()`-relative, conflict-checked one could.
    const classRes = await server.request({
      method: 'POST',
      path: '/api/classes',
      cookie,
      body: {
        title: 'Undeletable Session Fixture',
        discipline: 'Testing',
        defaultDurationMinutes: 30,
        defaultCapacity: 4,
      },
    });
    assert.equal(classRes.status, 201, classRes.raw);
    const [room] = await db('rooms')
      .insert({ name: `Undeletable Session Fixture Room ${Date.now()}` })
      .returning('*');
    const [session] = await db('sessions')
      .insert({
        class_id: classRes.json.class.id,
        primary_instructor_id: fixture.instructorA.id,
        room_id: room.id,
        starts_at: at(602).toISOString(),
        duration_minutes: 30,
        capacity: 4,
      })
      .returning('*');

    const [member] = await db('members')
      .insert({
        full_name: 'Sessions Test Member',
        email: `sessions-test-member-${Date.now()}@example.com`,
        membership_expires_on: new Date(Date.now() + 365 * 86_400_000)
          .toISOString()
          .slice(0, 10),
      })
      .returning('*');
    const [booking] = await db('bookings')
      .insert({
        session_id: session.id,
        member_id: member.id,
        status: 'booked',
      })
      .returning('*');
    await db('booking_events').insert({
      booking_id: booking.id,
      event_type: 'created',
      to_status: 'booked',
      actor_user_id: fixture.staff.id,
    });

    const res = await server.request({
      method: 'DELETE',
      path: `/api/sessions/${session.id}`,
      cookie,
    });
    assert.equal(res.status, 409);

    const row = await db('sessions').where({ id: session.id }).first();
    assert.ok(row, 'the session must still exist');
  });

  it('denies an instructor deleting a session', async () => {
    const cookie = await loginAs(fixture.staff);
    const created = await createSession(cookie, { startsAt: at(604).toISOString() });
    createdSessionIds.push(created.json.session.id);

    const instructorCookie = await loginAs(fixture.instructorA);
    const res = await server.request({
      method: 'DELETE',
      path: `/api/sessions/${created.json.session.id}`,
      cookie: instructorCookie,
    });
    assert.equal(res.status, 403);
  });

  it('404s for a session id that does not exist', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'DELETE',
      path: '/api/sessions/999999999',
      cookie,
    });
    assert.equal(res.status, 404);
  });
});
