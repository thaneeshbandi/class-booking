import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Goal 7, part A — `POST /api/sessions/recurring`, exercised over real HTTP
 * against a running app and a live database.
 *
 * Every describe block below is given its own well-separated slice of a
 * shared, randomized far-future day-offset window (`BASE`), so unrelated
 * scenarios sharing the same fixture room/instructor can never accidentally
 * conflict with each other. `BASE` is randomized (not fixed) so repeated
 * runs of this file never collide with a previous run's own leftover
 * fixtures the way a fixed offset could — the same reasoning
 * `sessions.test.js`'s `p6Base` already documents.
 */

let server;
const fixture = {};
const createdSessionIds = [];
const createdClassIds = [];
const createdRoomIds = [];

const BASE = 300 + Math.floor(Math.random() * 3000);

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

/** `YYYY-MM-DD` for `days` days from now. */
function isoDate(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekdayOfIsoDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The exact instant PostgreSQL's `AT TIME ZONE` resolves a local date/time
 * to, computed the same way the application itself does — used here only to
 * set up conflicting fixture sessions at a precise instant, not as part of
 * what is under test. */
async function resolveInstant(dateStr, localStartTime) {
  const { rows } = await db.raw('SELECT (?::timestamp AT TIME ZONE ?) AS starts_at', [
    `${dateStr} ${localStartTime}:00`,
    env.STUDIO_TIMEZONE,
  ]);
  return rows[0].starts_at;
}

function recurringRequest(cookie, overrides = {}) {
  return server.request({
    method: 'POST',
    path: '/api/sessions/recurring',
    cookie,
    body: {
      classId: fixture.class.id,
      primaryInstructorId: fixture.instructorA.id,
      roomId: fixture.room.id,
      localStartTime: '09:00',
      ...overrides,
    },
  });
}

before(async () => {
  server = await startTestServer();

  fixture.staff = await db('users').where({ role: 'staff', is_active: true }).first();
  const instructors = await db('users')
    .where({ role: 'instructor', is_active: true })
    .select('*');
  assert.ok(instructors.length >= 2, 'seed data requires at least two active instructors');
  [fixture.instructorA, fixture.instructorB] = instructors;

  const rooms = await db('rooms')
    .insert([
      { name: `Recurring Test Room A ${Date.now()}` },
      { name: `Recurring Test Room B ${Date.now()}` },
    ])
    .returning('*');
  [fixture.room, fixture.roomOther] = rooms;
  createdRoomIds.push(fixture.room.id, fixture.roomOther.id);

  const [klass] = await db('classes')
    .insert({
      title: `Recurring Test Class ${Date.now()}`,
      discipline: 'Testing',
      default_duration_minutes: 60,
      default_capacity: 5,
    })
    .returning('*');
  fixture.class = klass;
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

describe('POST /api/sessions/recurring — authorization', () => {
  it('denies an unauthenticated request', async () => {
    const startDate = isoDate(BASE);
    const res = await server.request({
      method: 'POST',
      path: '/api/sessions/recurring',
      body: {
        classId: fixture.class.id,
        primaryInstructorId: fixture.instructorA.id,
        roomId: fixture.room.id,
        startDate,
        endDate: startDate,
        localStartTime: '09:00',
        weekdays: [weekdayOfIsoDate(startDate)],
      },
    });
    assert.equal(res.status, 401);
  });

  it('denies an instructor generating sessions', async () => {
    const cookie = await loginAs(fixture.instructorA);
    const startDate = isoDate(BASE + 1);
    const res = await recurringRequest(cookie, {
      startDate,
      endDate: startDate,
      weekdays: [weekdayOfIsoDate(startDate)],
    });
    assert.equal(res.status, 403);
  });

  it('cannot be bypassed by an instructor spoofing a staff role in the body', async () => {
    const cookie = await loginAs(fixture.instructorA);
    const startDate = isoDate(BASE + 1);
    const res = await recurringRequest(cookie, {
      startDate,
      endDate: startDate,
      weekdays: [weekdayOfIsoDate(startDate)],
      role: 'staff',
    });
    assert.equal(res.status, 403);
  });
});

describe('POST /api/sessions/recurring — generation', () => {
  it('lets staff generate a weekly recurrence, creating every expected date in chronological order', async () => {
    const cookie = await loginAs(fixture.staff);
    const startDate = isoDate(BASE + 10);
    const weekday = weekdayOfIsoDate(startDate);
    const endDate = addDays(startDate, 21); // four weekly occurrences: 0, 7, 14, 21

    const res = await recurringRequest(cookie, { startDate, endDate, weekdays: [weekday] });
    assert.equal(res.status, 200, res.raw);
    res.json.created.forEach((s) => createdSessionIds.push(s.id));

    assert.equal(res.json.created.length, 4, res.raw);
    assert.equal(res.json.skipped.length, 0, res.raw);
    assert.deepEqual(
      res.json.created.map((s) => s.date),
      [startDate, addDays(startDate, 7), addDays(startDate, 14), addDays(startDate, 21)],
    );

    // Chronological order: each created session's startsAt strictly increases.
    const startsAtValues = res.json.created.map((s) => new Date(s.startsAt).getTime());
    for (let i = 1; i < startsAtValues.length; i += 1) {
      assert.ok(startsAtValues[i] > startsAtValues[i - 1], 'created sessions must be chronological');
    }

    for (const session of res.json.created) {
      assert.equal(String(session.classId), String(fixture.class.id));
      assert.equal(String(session.primaryInstructorId), String(fixture.instructorA.id));
      assert.equal(String(session.roomId), String(fixture.room.id));
      assert.equal(session.durationMinutes, fixture.class.default_duration_minutes);
      assert.equal(session.capacity, fixture.class.default_capacity);
    }
  });

  it('overrides duration and capacity from the request body instead of the class defaults', async () => {
    const cookie = await loginAs(fixture.staff);
    const startDate = isoDate(BASE + 40);

    const res = await recurringRequest(cookie, {
      startDate,
      endDate: startDate,
      weekdays: [weekdayOfIsoDate(startDate)],
      durationMinutes: 45,
      capacity: 2,
    });
    assert.equal(res.status, 200, res.raw);
    res.json.created.forEach((s) => createdSessionIds.push(s.id));

    assert.equal(res.json.created.length, 1, res.raw);
    assert.equal(res.json.created[0].durationMinutes, 45);
    assert.equal(res.json.created[0].capacity, 2);
  });

  it('treats an existing session ending exactly when a candidate starts as non-overlapping', async () => {
    const cookie = await loginAs(fixture.staff);
    const startDate = isoDate(BASE + 50);
    const candidateInstant = await resolveInstant(startDate, '09:00');

    // Ends exactly at the candidate's start (60-minute duration, one hour earlier).
    const [boundarySession] = await db('sessions')
      .insert({
        class_id: fixture.class.id,
        primary_instructor_id: fixture.instructorA.id,
        room_id: fixture.room.id,
        starts_at: new Date(new Date(candidateInstant).getTime() - 60 * 60_000),
        duration_minutes: 60,
        capacity: 5,
      })
      .returning('*');
    createdSessionIds.push(boundarySession.id);

    const res = await recurringRequest(cookie, {
      startDate,
      endDate: startDate,
      weekdays: [weekdayOfIsoDate(startDate)],
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.skipped.length, 0, res.raw);
    assert.equal(res.json.created.length, 1, res.raw);
    createdSessionIds.push(res.json.created[0].id);
  });

  it('rejects generating sessions for an archived class', async () => {
    const cookie = await loginAs(fixture.staff);
    const classRes = await server.request({
      method: 'POST',
      path: '/api/classes',
      cookie,
      body: {
        title: `Recurring Archived Test Class ${Date.now()}`,
        discipline: 'Testing',
        defaultDurationMinutes: 60,
        defaultCapacity: 5,
      },
    });
    assert.equal(classRes.status, 201, classRes.raw);
    createdClassIds.push(classRes.json.class.id);
    await server.request({
      method: 'POST',
      path: `/api/classes/${classRes.json.class.id}/archive`,
      cookie,
    });

    const startDate = isoDate(BASE + 60);
    const res = await recurringRequest(cookie, {
      classId: classRes.json.class.id,
      startDate,
      endDate: startDate,
      weekdays: [weekdayOfIsoDate(startDate)],
    });
    assert.equal(res.status, 409, res.raw);
  });

  it('returns 400 with no session created when the range/weekday combination has no candidates', async () => {
    const cookie = await loginAs(fixture.staff);
    const startDate = isoDate(BASE + 70);
    const otherWeekday = (weekdayOfIsoDate(startDate) + 1) % 7;
    const res = await recurringRequest(cookie, {
      startDate,
      endDate: startDate,
      weekdays: [otherWeekday],
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/sessions/recurring — conflict skipping', () => {
  it('skips a candidate that room-conflicts with an existing session, and still creates the rest', async () => {
    const cookie = await loginAs(fixture.staff);
    const startDate = isoDate(BASE + 100);
    const weekday = weekdayOfIsoDate(startDate);
    const middleDate = addDays(startDate, 7);
    const endDate = addDays(startDate, 14);

    // A pre-existing session in the same room, a different instructor, at
    // exactly the middle candidate's instant — a pure room conflict, since
    // instructorA (the recurrence's primary instructor) is not involved.
    const conflictInstant = await resolveInstant(middleDate, '09:00');
    const [conflictSession] = await db('sessions')
      .insert({
        class_id: fixture.class.id,
        primary_instructor_id: fixture.instructorB.id,
        room_id: fixture.room.id,
        starts_at: conflictInstant,
        duration_minutes: 60,
        capacity: 5,
      })
      .returning('*');
    createdSessionIds.push(conflictSession.id);

    const res = await recurringRequest(cookie, { startDate, endDate, weekdays: [weekday] });
    assert.equal(res.status, 200, res.raw);
    res.json.created.forEach((s) => createdSessionIds.push(s.id));

    assert.equal(res.json.created.length, 2, res.raw);
    assert.equal(res.json.skipped.length, 1, res.raw);
    assert.equal(res.json.skipped[0].date, middleDate);
    assert.equal(res.json.skipped[0].reason, 'room_conflict');
    assert.ok(res.json.skipped[0].conflict);
    assert.deepEqual(
      res.json.created.map((s) => s.date),
      [startDate, endDate],
    );
  });

  it('skips a candidate that instructor-conflicts with an existing session, and still creates the rest', async () => {
    const cookie = await loginAs(fixture.staff);
    const startDate = isoDate(BASE + 200);
    const weekday = weekdayOfIsoDate(startDate);
    const middleDate = addDays(startDate, 7);
    const endDate = addDays(startDate, 14);

    // A pre-existing session for the same instructor (instructorA) in a
    // different room — a pure instructor conflict, since the recurrence
    // itself targets `fixture.room`.
    const conflictInstant = await resolveInstant(middleDate, '09:00');
    const [conflictSession] = await db('sessions')
      .insert({
        class_id: fixture.class.id,
        primary_instructor_id: fixture.instructorA.id,
        room_id: fixture.roomOther.id,
        starts_at: conflictInstant,
        duration_minutes: 60,
        capacity: 5,
      })
      .returning('*');
    createdSessionIds.push(conflictSession.id);

    const res = await recurringRequest(cookie, { startDate, endDate, weekdays: [weekday] });
    assert.equal(res.status, 200, res.raw);
    res.json.created.forEach((s) => createdSessionIds.push(s.id));

    assert.equal(res.json.created.length, 2, res.raw);
    assert.equal(res.json.skipped.length, 1, res.raw);
    assert.equal(res.json.skipped[0].date, middleDate);
    assert.equal(res.json.skipped[0].reason, 'instructor_conflict');
  });
});

describe('POST /api/sessions/recurring — duplicate generation', () => {
  it('skips every candidate as existing_session on a repeated identical request, creating nothing new', async () => {
    const cookie = await loginAs(fixture.staff);
    const startDate = isoDate(BASE + 300);
    const endDate = addDays(startDate, 7);
    const weekday = weekdayOfIsoDate(startDate);
    const body = { startDate, endDate, weekdays: [weekday] };

    const first = await recurringRequest(cookie, body);
    assert.equal(first.status, 200, first.raw);
    first.json.created.forEach((s) => createdSessionIds.push(s.id));
    assert.equal(first.json.created.length, 2, first.raw);
    assert.equal(first.json.skipped.length, 0, first.raw);

    const second = await recurringRequest(cookie, body);
    assert.equal(second.status, 200, second.raw);
    assert.equal(second.json.created.length, 0, second.raw);
    assert.equal(second.json.skipped.length, 2, second.raw);
    for (const skip of second.json.skipped) {
      assert.equal(skip.reason, 'existing_session');
    }
  });
});

describe('POST /api/sessions/recurring — DST', () => {
  it('preserves the intended local wall-clock time across a DST transition', async () => {
    const cookie = await loginAs(fixture.staff);
    const startDate = isoDate(BASE + 600);
    const endDate = addDays(startDate, 370); // guaranteed to span a full year
    const weekday = weekdayOfIsoDate(startDate);

    const res = await recurringRequest(cookie, {
      startDate,
      endDate,
      weekdays: [weekday],
      roomId: fixture.roomOther.id, // isolate from other describe blocks' fixture room
    });
    assert.equal(res.status, 200, res.raw);
    res.json.created.forEach((s) => createdSessionIds.push(s.id));
    assert.ok(res.json.created.length >= 52, `expected ~53 weekly sessions, got ${res.json.created.length}`);
    assert.equal(res.json.skipped.length, 0, res.raw);

    const localTimeFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: env.STUDIO_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });

    const utcHours = new Set();
    for (const session of res.json.created) {
      const instant = new Date(session.startsAt);
      assert.equal(
        localTimeFormatter.format(instant),
        '09:00',
        `session on ${session.date} must read 09:00 in ${env.STUDIO_TIMEZONE}, not drift with DST`,
      );
      utcHours.add(instant.getUTCHours());
    }

    // A genuine cross-check that this test actually spans a DST transition
    // (STUDIO_TIMEZONE is Europe/London in this project's .env, which
    // observes DST): the UTC hour behind a fixed 09:00 local time must
    // differ between summer and winter.
    assert.ok(
      utcHours.size >= 2,
      'expected sessions on both sides of a DST transition to resolve to different UTC hours',
    );
  });
});
