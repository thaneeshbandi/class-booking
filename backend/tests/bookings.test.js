import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Goal 4 — the booking lifecycle, exercised over real HTTP against a running
 * app and a live database. Grown across phases P3 (creation), P4
 * (cancellation + waitlist promotion) and P5 (settlement, GET, history,
 * authorization) — each phase's describe blocks are added in their own
 * commit, matching `sessions.test.js`'s single-growing-file convention.
 *
 * Fixture room/class are created once per run with a unique suffix and never
 * deleted: once a session has a real booking attached, `bookings.session_id`
 * (ON DELETE RESTRICT) and the append-only `booking_events` table make it
 * permanently undeletable by design, so uniqueness — not cleanup — is what
 * keeps repeated runs from colliding (see `bookingTransaction.test.js`).
 */

let server;
const RUN = Date.now();
const fixture = {};

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

function futureDate(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3_600_000);
}

async function studioToday() {
  const { rows } = await db.raw(
    `SELECT to_char((now() AT TIME ZONE ?), 'YYYY-MM-DD') AS today`,
    [env.STUDIO_TIMEZONE],
  );
  return rows[0].today;
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Directly-inserted session, bypassing the conflict-checked POST endpoint —
 * full control over capacity/timing is what these tests need, and none of
 * them care about room/instructor scheduling conflicts. */
async function createRawSession({ capacity = 5, startsAt = futureDate(24), durationMinutes = 60 } = {}) {
  const [session] = await db('sessions')
    .insert({
      class_id: fixture.class.id,
      primary_instructor_id: fixture.instructorA.id,
      room_id: fixture.room.id,
      starts_at: startsAt,
      duration_minutes: durationMinutes,
      capacity,
    })
    .returning('*');
  return session;
}

let memberCounter = 0;
async function createMember({ expiresOn = '2099-01-01' } = {}) {
  memberCounter += 1;
  const [member] = await db('members')
    .insert({
      full_name: `Bookings Test Member ${RUN}-${memberCounter}`,
      email: `bookings-test-${RUN}-${memberCounter}@example.com`,
      membership_expires_on: expiresOn,
    })
    .returning('*');
  return member;
}

before(async () => {
  server = await startTestServer();

  fixture.staff = await db('users').where({ role: 'staff', is_active: true }).first();
  const instructors = await db('users')
    .where({ role: 'instructor', is_active: true })
    .select('*');
  assert.ok(instructors.length >= 1, 'seed data requires at least one active instructor');
  [fixture.instructorA, fixture.instructorB] = instructors;

  [fixture.room] = await db('rooms').insert({ name: `Bookings Test Room ${RUN}` }).returning('*');
  [fixture.class] = await db('classes')
    .insert({
      title: `Bookings Test Class ${RUN}`,
      discipline: 'Testing',
      default_duration_minutes: 60,
      default_capacity: 5,
    })
    .returning('*');
});

after(async () => {
  await server.stop();
  await closeConnection();
});

describe('POST /api/bookings — creation', () => {
  it('books directly into a session with free capacity', async () => {
    const session = await createRawSession({ capacity: 5 });
    const member = await createMember();
    const cookie = await loginAs(fixture.staff);

    const res = await server.request({
      method: 'POST',
      path: '/api/bookings',
      cookie,
      body: { sessionId: String(session.id), memberId: String(member.id) },
    });
    assert.equal(res.status, 201, res.raw);
    assert.equal(res.json.booking.status, 'booked');
    assert.equal(String(res.json.booking.sessionId), String(session.id));
    assert.equal(String(res.json.booking.memberId), String(member.id));
    assert.equal(res.json.booking.member.email, member.email);
  });

  it('waitlists once the session is full', async () => {
    const session = await createRawSession({ capacity: 1 });
    const first = await createMember();
    const second = await createMember();
    const cookie = await loginAs(fixture.staff);

    const firstRes = await server.request({
      method: 'POST',
      path: '/api/bookings',
      cookie,
      body: { sessionId: String(session.id), memberId: String(first.id) },
    });
    assert.equal(firstRes.status, 201, firstRes.raw);
    assert.equal(firstRes.json.booking.status, 'booked');

    const secondRes = await server.request({
      method: 'POST',
      path: '/api/bookings',
      cookie,
      body: { sessionId: String(session.id), memberId: String(second.id) },
    });
    assert.equal(secondRes.status, 201, secondRes.raw);
    assert.equal(secondRes.json.booking.status, 'waitlisted');
  });

  it('books exactly the first N members into a capacity-N session and waitlists the rest', async () => {
    const capacity = 3;
    const session = await createRawSession({ capacity });
    const members = await Promise.all([1, 2, 3, 4].map(() => createMember()));
    const cookie = await loginAs(fixture.staff);

    const statuses = [];
    for (const member of members) {
      const res = await server.request({
        method: 'POST',
        path: '/api/bookings',
        cookie,
        body: { sessionId: String(session.id), memberId: String(member.id) },
      });
      assert.equal(res.status, 201, res.raw);
      statuses.push(res.json.booking.status);
    }
    assert.deepEqual(statuses, ['booked', 'booked', 'booked', 'waitlisted']);
  });

  it('rejects a booking for a member whose membership has expired', async () => {
    const session = await createRawSession({ capacity: 5 });
    const today = await studioToday();
    const member = await createMember({ expiresOn: addDays(today, -1) });
    const cookie = await loginAs(fixture.staff);

    const res = await server.request({
      method: 'POST',
      path: '/api/bookings',
      cookie,
      body: { sessionId: String(session.id), memberId: String(member.id) },
    });
    assert.equal(res.status, 409, res.raw);
  });

  it('allows a booking when membership expires exactly today', async () => {
    const session = await createRawSession({ capacity: 5 });
    const today = await studioToday();
    const member = await createMember({ expiresOn: today });
    const cookie = await loginAs(fixture.staff);

    const res = await server.request({
      method: 'POST',
      path: '/api/bookings',
      cookie,
      body: { sessionId: String(session.id), memberId: String(member.id) },
    });
    assert.equal(res.status, 201, res.raw);
  });

  it('rejects a duplicate active booking for the same member and session', async () => {
    const session = await createRawSession({ capacity: 5 });
    const member = await createMember();
    const cookie = await loginAs(fixture.staff);

    const first = await server.request({
      method: 'POST',
      path: '/api/bookings',
      cookie,
      body: { sessionId: String(session.id), memberId: String(member.id) },
    });
    assert.equal(first.status, 201, first.raw);

    const second = await server.request({
      method: 'POST',
      path: '/api/bookings',
      cookie,
      body: { sessionId: String(session.id), memberId: String(member.id) },
    });
    assert.equal(second.status, 409, second.raw);
  });

  it('rejects creating a booking once the session has started', async () => {
    const session = await createRawSession({ startsAt: futureDate(-1), durationMinutes: 600 });
    const member = await createMember();
    const cookie = await loginAs(fixture.staff);

    const res = await server.request({
      method: 'POST',
      path: '/api/bookings',
      cookie,
      body: { sessionId: String(session.id), memberId: String(member.id) },
    });
    assert.equal(res.status, 409, res.raw);
  });

  it('writes a single created event matching the booking outcome, with the staff actor', async () => {
    const session = await createRawSession({ capacity: 5 });
    const member = await createMember();
    const cookie = await loginAs(fixture.staff);

    const res = await server.request({
      method: 'POST',
      path: '/api/bookings',
      cookie,
      body: { sessionId: String(session.id), memberId: String(member.id) },
    });
    assert.equal(res.status, 201, res.raw);

    const events = await db('booking_events').where({ booking_id: res.json.booking.id });
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'created');
    assert.equal(events[0].from_status, null);
    assert.equal(events[0].to_status, 'booked');
    assert.equal(String(events[0].actor_user_id), String(fixture.staff.id));
    assert.equal(events[0].is_automatic, false);
  });

  it('denies an instructor creating a booking', async () => {
    const session = await createRawSession({ capacity: 5 });
    const member = await createMember();
    const cookie = await loginAs(fixture.instructorA);

    const res = await server.request({
      method: 'POST',
      path: '/api/bookings',
      cookie,
      body: { sessionId: String(session.id), memberId: String(member.id) },
    });
    assert.equal(res.status, 403);
  });

  it('denies an unauthenticated request', async () => {
    const session = await createRawSession({ capacity: 5 });
    const member = await createMember();

    const res = await server.request({
      method: 'POST',
      path: '/api/bookings',
      body: { sessionId: String(session.id), memberId: String(member.id) },
    });
    assert.equal(res.status, 401);
  });

  describe('validation', () => {
    it('rejects a malformed sessionId or memberId', async () => {
      const cookie = await loginAs(fixture.staff);
      const badSession = await server.request({
        method: 'POST',
        path: '/api/bookings',
        cookie,
        body: { sessionId: 'not-an-id', memberId: '1' },
      });
      assert.equal(badSession.status, 400);

      const numericBody = await server.request({
        method: 'POST',
        path: '/api/bookings',
        cookie,
        body: { sessionId: 1, memberId: 1 },
      });
      assert.equal(numericBody.status, 400, 'ids must be bigint-safe strings, not JSON numbers');
    });

    it('rejects an unknown member id', async () => {
      const session = await createRawSession({ capacity: 5 });
      const cookie = await loginAs(fixture.staff);
      const res = await server.request({
        method: 'POST',
        path: '/api/bookings',
        cookie,
        body: { sessionId: String(session.id), memberId: '999999999' },
      });
      assert.equal(res.status, 400);
    });

    it('404s for an unknown session id', async () => {
      const member = await createMember();
      const cookie = await loginAs(fixture.staff);
      const res = await server.request({
        method: 'POST',
        path: '/api/bookings',
        cookie,
        body: { sessionId: '999999999', memberId: String(member.id) },
      });
      assert.equal(res.status, 404);
    });
  });

  it('under two simultaneous creates for a capacity-1 session, exactly one is booked and one is waitlisted', async () => {
    const session = await createRawSession({ capacity: 1 });
    const [memberA, memberB] = await Promise.all([createMember(), createMember()]);
    const cookie = await loginAs(fixture.staff);

    const [resA, resB] = await Promise.all([
      server.request({
        method: 'POST',
        path: '/api/bookings',
        cookie,
        body: { sessionId: String(session.id), memberId: String(memberA.id) },
      }),
      server.request({
        method: 'POST',
        path: '/api/bookings',
        cookie,
        body: { sessionId: String(session.id), memberId: String(memberB.id) },
      }),
    ]);

    const statuses = [resA.json.booking.status, resB.json.booking.status].sort();
    assert.deepEqual(statuses, ['booked', 'waitlisted']);

    const occupied = await db('bookings')
      .where({ session_id: session.id })
      .whereIn('status', ['booked', 'attended', 'no_show'])
      .count({ count: '*' })
      .first();
    assert.equal(Number(occupied.count), 1, 'I1: occupied must never exceed capacity');
  });
});
