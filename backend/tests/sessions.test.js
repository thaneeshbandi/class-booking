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

  describe('booking-aware capacity and reschedule rules (goal 4, phase P6)', () => {
    // Every session below gets a real booking attached, which makes it
    // permanently undeletable (bookings.session_id is ON DELETE RESTRICT and
    // booking_events is append-only) — so, unlike the rest of this file,
    // these sessions must NOT be pushed onto the shared `createdSessionIds`
    // array: a single undeletable id in that array would fail the shared
    // bulk `after()` delete for every other test's cleanup too, and in turn
    // block deleting `fixture.class`/`fixture.roomA` themselves (a session
    // referencing them is enough, booking or not). A dedicated, uniquely
    // named, never-cleaned-up class and room — the same pattern
    // `sessions.test.js`'s own "Undeletable Session Fixture" test already
    // uses — keeps this describe block's permanent footprint isolated from
    // the rest of the suite.
    let bookingAwareClassId;
    let bookingAwareRoomId;

    // These sessions are permanent (see above), and all use the shared
    // `fixture.instructorA` — so, unlike the rest of this file's fixed
    // `at(N)` offsets (safe because their sessions ARE cleaned up), a fixed
    // offset here would collide with the *previous* run's leftover session
    // for the same instructor at nearly the same instant (`WINDOW_START`
    // drifts only by the wall-clock gap between runs). A randomized base,
    // spread wide, keeps repeated runs from ever landing on the same slot.
    const p6Base = 1000 + Math.floor(Math.random() * 20_000);

    before(async () => {
      const [room] = await db('rooms')
        .insert({ name: `Booking-Aware PATCH Test Room ${Date.now()}` })
        .returning('*');
      bookingAwareRoomId = room.id;
      const cookie = await loginAs(fixture.staff);
      const classRes = await server.request({
        method: 'POST',
        path: '/api/classes',
        cookie,
        body: {
          title: `Booking-Aware PATCH Test Class ${Date.now()}`,
          discipline: 'Testing',
          defaultDurationMinutes: 60,
          defaultCapacity: 5,
        },
      });
      assert.equal(classRes.status, 201, classRes.raw);
      bookingAwareClassId = classRes.json.class.id;
    });

    function createBookingAwareSession(cookie, overrides = {}) {
      return createSession(cookie, {
        classId: bookingAwareClassId,
        roomId: bookingAwareRoomId,
        ...overrides,
      });
    }

    async function createPatchTestMember() {
      const [member] = await db('members')
        .insert({
          full_name: 'Session Patch Test Member',
          email: `session-patch-test-member-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
          membership_expires_on: '2099-01-01',
        })
        .returning('*');
      return member;
    }

    async function bookMember(cookie, sessionId, memberId) {
      const res = await server.request({
        method: 'POST',
        path: '/api/bookings',
        cookie,
        body: { sessionId: String(sessionId), memberId: String(memberId) },
      });
      assert.equal(res.status, 201, res.raw);
      return res.json.booking;
    }

    it('rejects lowering capacity below the number of occupied seats', async () => {
      const cookie = await loginAs(fixture.staff);
      const created = await createBookingAwareSession(cookie, { startsAt: at(p6Base + 700).toISOString(), capacity: 2 });
      const [m1, m2] = await Promise.all([createPatchTestMember(), createPatchTestMember()]);
      await bookMember(cookie, created.json.session.id, m1.id);
      await bookMember(cookie, created.json.session.id, m2.id);

      const res = await server.request({
        method: 'PATCH',
        path: `/api/sessions/${created.json.session.id}`,
        cookie,
        body: { capacity: 1 },
      });
      assert.equal(res.status, 409, res.raw);
    });

    it('allows lowering capacity to exactly the number occupied', async () => {
      const cookie = await loginAs(fixture.staff);
      const created = await createBookingAwareSession(cookie, { startsAt: at(p6Base + 702).toISOString(), capacity: 3 });
      const member = await createPatchTestMember();
      await bookMember(cookie, created.json.session.id, member.id);

      const res = await server.request({
        method: 'PATCH',
        path: `/api/sessions/${created.json.session.id}`,
        cookie,
        body: { capacity: 1 },
      });
      assert.equal(res.status, 200, res.raw);
      assert.equal(res.json.session.capacity, 1);
    });

    it('promotes FIFO-waitlisted bookings when capacity is increased, with caused_by_booking_id null', async () => {
      const cookie = await loginAs(fixture.staff);
      const created = await createBookingAwareSession(cookie, { startsAt: at(p6Base + 704).toISOString(), capacity: 1 });
      const [holder, first, second] = await Promise.all([
        createPatchTestMember(),
        createPatchTestMember(),
        createPatchTestMember(),
      ]);
      await bookMember(cookie, created.json.session.id, holder.id);
      const firstWaitlisted = await bookMember(cookie, created.json.session.id, first.id);
      const secondWaitlisted = await bookMember(cookie, created.json.session.id, second.id);
      assert.equal(firstWaitlisted.status, 'waitlisted');
      assert.equal(secondWaitlisted.status, 'waitlisted');

      const res = await server.request({
        method: 'PATCH',
        path: `/api/sessions/${created.json.session.id}`,
        cookie,
        body: { capacity: 2 },
      });
      assert.equal(res.status, 200, res.raw);
      assert.equal(res.json.promoted.length, 1);
      assert.equal(String(res.json.promoted[0].id), String(firstWaitlisted.id));

      const stillWaiting = await db('bookings').where({ id: secondWaitlisted.id }).first();
      assert.equal(stillWaiting.status, 'waitlisted');

      const promotionEvent = await db('booking_events')
        .where({ booking_id: firstWaitlisted.id, event_type: 'status_changed' })
        .first();
      assert.equal(promotionEvent.is_automatic, true);
      assert.equal(promotionEvent.caused_by_booking_id, null);
    });

    it('rejects changing start time or duration once a session has a settled booking, but still allows capacity', async () => {
      const cookie = await loginAs(fixture.staff);
      const created = await createBookingAwareSession(cookie, { startsAt: at(p6Base + 706).toISOString(), capacity: 5 });
      const member = await createPatchTestMember();
      const booking = await bookMember(cookie, created.json.session.id, member.id);

      // Relocate into the past — settlement requires a finished session —
      // then settle, which is what the reschedule rule keys off. A
      // randomized number of years in the past, not a fixed instant: the
      // capacity-only PATCH below still re-runs the room/instructor conflict
      // check against this instructor's *current* schedule, this session is
      // permanent (see above), and a fixed instant would collide with the
      // very same test's own leftover session from a previous run.
      const randomPastHoursAgo = 10_000 + Math.floor(Math.random() * 500_000);
      await db('sessions')
        .where({ id: created.json.session.id })
        .update({ starts_at: new Date(Date.now() - randomPastHoursAgo * 3_600_000) });
      const settleRes = await server.request({
        method: 'POST',
        path: `/api/bookings/${booking.id}/settle`,
        cookie,
        body: { status: 'attended' },
      });
      assert.equal(settleRes.status, 200, settleRes.raw);

      const rescheduleRes = await server.request({
        method: 'PATCH',
        path: `/api/sessions/${created.json.session.id}`,
        cookie,
        body: { startsAt: new Date(Date.now() + 3_600_000).toISOString() },
      });
      assert.equal(rescheduleRes.status, 409, rescheduleRes.raw);

      const durationRes = await server.request({
        method: 'PATCH',
        path: `/api/sessions/${created.json.session.id}`,
        cookie,
        body: { durationMinutes: 90 },
      });
      assert.equal(durationRes.status, 409, durationRes.raw);

      const capacityRes = await server.request({
        method: 'PATCH',
        path: `/api/sessions/${created.json.session.id}`,
        cookie,
        body: { capacity: 10 },
      });
      assert.equal(capacityRes.status, 200, capacityRes.raw);
    });

    it('holds I1/I2 under a concurrent capacity increase and a new booking create, regardless of interleaving', async () => {
      const cookie = await loginAs(fixture.staff);
      const created = await createBookingAwareSession(cookie, { startsAt: at(p6Base + 710).toISOString(), capacity: 1 });
      const [holder, waiter, newcomer] = await Promise.all([
        createPatchTestMember(),
        createPatchTestMember(),
        createPatchTestMember(),
      ]);
      await bookMember(cookie, created.json.session.id, holder.id);
      const waitlisted = await bookMember(cookie, created.json.session.id, waiter.id);
      assert.equal(waitlisted.status, 'waitlisted');

      const [patchRes, createRes] = await Promise.all([
        server.request({
          method: 'PATCH',
          path: `/api/sessions/${created.json.session.id}`,
          cookie,
          body: { capacity: 2 },
        }),
        server.request({
          method: 'POST',
          path: '/api/bookings',
          cookie,
          body: { sessionId: String(created.json.session.id), memberId: String(newcomer.id) },
        }),
      ]);
      assert.equal(patchRes.status, 200, patchRes.raw);
      assert.equal(createRes.status, 201, createRes.raw);

      // `waiter` was waitlisted before either concurrent request began, so
      // FIFO order guarantees it wins the freed seat under either possible
      // interleaving of the capacity increase and the new create.
      const rows = await db('bookings')
        .where({ session_id: created.json.session.id })
        .select('member_id', 'status');
      const byMember = Object.fromEntries(rows.map((row) => [String(row.member_id), row.status]));
      assert.equal(byMember[String(holder.id)], 'booked');
      assert.equal(byMember[String(waiter.id)], 'booked');
      assert.equal(byMember[String(newcomer.id)], 'waitlisted');

      const occupied = rows.filter((row) => ['booked', 'attended', 'no_show'].includes(row.status)).length;
      const sessionRow = await db('sessions').where({ id: created.json.session.id }).first();
      assert.ok(occupied <= sessionRow.capacity, 'I1: occupied must never exceed capacity');
    });

    it('rejects a concurrent capacity decrease below occupancy regardless of interleaving with a new booking create (stale-read protection)', async () => {
      const cookie = await loginAs(fixture.staff);
      const created = await createBookingAwareSession(cookie, { startsAt: at(p6Base + 712).toISOString(), capacity: 2 });
      const [h1, h2, newcomer] = await Promise.all([
        createPatchTestMember(),
        createPatchTestMember(),
        createPatchTestMember(),
      ]);
      await bookMember(cookie, created.json.session.id, h1.id);
      await bookMember(cookie, created.json.session.id, h2.id);

      const [patchRes, createRes] = await Promise.all([
        server.request({
          method: 'PATCH',
          path: `/api/sessions/${created.json.session.id}`,
          cookie,
          body: { capacity: 1 },
        }),
        server.request({
          method: 'POST',
          path: '/api/bookings',
          cookie,
          body: { sessionId: String(created.json.session.id), memberId: String(newcomer.id) },
        }),
      ]);
      // The session lock serializes the two requests, so the decrease sees
      // the true occupancy at the time it actually runs — never a value read
      // before the other request's effects landed — and is rejected either
      // way.
      assert.equal(patchRes.status, 409, patchRes.raw);
      assert.equal(createRes.status, 201, createRes.raw);
      assert.equal(createRes.json.booking.status, 'waitlisted');

      const sessionRow = await db('sessions').where({ id: created.json.session.id }).first();
      assert.equal(sessionRow.capacity, 2, 'capacity must remain unchanged after the rejected decrease');
    });
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

  it('under a concurrent delete and a new booking create, exactly one succeeds and the database never ends up inconsistent', async () => {
    // Its own throwaway class/room, same reasoning as the booking-aware
    // PATCH describe block above: this session may end up permanently
    // booking-carrying depending on how the race resolves, and must not
    // poison the shared fixture cleanup either way.
    const cookie = await loginAs(fixture.staff);
    const [room] = await db('rooms')
      .insert({ name: `Undeletable Session Race Room ${Date.now()}` })
      .returning('*');
    const classRes = await server.request({
      method: 'POST',
      path: '/api/classes',
      cookie,
      body: {
        title: `Undeletable Session Race Class ${Date.now()}`,
        discipline: 'Testing',
        defaultDurationMinutes: 60,
        defaultCapacity: 5,
      },
    });
    assert.equal(classRes.status, 201, classRes.raw);

    // A randomized offset, not a fixed one: this session may end up
    // permanently booking-carrying (see below) and reuses the shared
    // fixture.instructorA, so a fixed instant would risk colliding with a
    // previous run's own leftover session the same way the booking-aware
    // PATCH tests above do.
    const created = await createSession(cookie, {
      classId: classRes.json.class.id,
      roomId: room.id,
      startsAt: at(1000 + Math.floor(Math.random() * 20_000)).toISOString(),
      capacity: 5,
    });
    assert.equal(created.status, 201, created.raw);
    const [member] = await db('members')
      .insert({
        full_name: 'Session Delete Race Member',
        email: `session-delete-race-${Date.now()}@example.com`,
        membership_expires_on: '2099-01-01',
      })
      .returning('*');

    const [deleteRes, createRes] = await Promise.all([
      server.request({ method: 'DELETE', path: `/api/sessions/${created.json.session.id}`, cookie }),
      server.request({
        method: 'POST',
        path: '/api/bookings',
        cookie,
        body: { sessionId: String(created.json.session.id), memberId: String(member.id) },
      }),
    ]);

    if (deleteRes.status === 204) {
      assert.equal(
        createRes.status,
        404,
        'a booking cannot be created on a session that was concurrently deleted',
      );
      const row = await db('sessions').where({ id: created.json.session.id }).first();
      assert.equal(row, undefined);
    } else {
      assert.equal(deleteRes.status, 409, deleteRes.raw);
      assert.equal(createRes.status, 201, createRes.raw);
      const row = await db('sessions').where({ id: created.json.session.id }).first();
      assert.ok(row, 'the session must still exist since it now has a booking attached');
    }
  });
});
