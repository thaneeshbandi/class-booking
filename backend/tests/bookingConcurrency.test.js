import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Phase P7 — dedicated concurrency hardening for the booking lifecycle.
 *
 * Every request pair/group below is issued with client-side `Promise.all`
 * against a running HTTP server — genuine concurrent requests, each on its
 * own connection, not sequential awaits dressed up as concurrent. Every
 * assertion is against final database state (I1: occupied <= capacity: I2:
 * a waitlisted booking implies occupied >= capacity), not merely HTTP status
 * codes, per the approved design.
 *
 * The session-row lock (`lockSessionForBooking`, `domain/bookingTransaction.js`)
 * is the mutex under test: every scenario below has two request-level
 * orderings the OS could pick, and for four of the six scenarios the FIFO
 * waitlist rule (`created_at ASC, id ASC`) makes the two orderings converge
 * on the *same* final state — which this file asserts exactly. The capacity
 * -decrease-vs-create scenario is a genuine race with two legitimate
 * outcomes; there the assertion is that both outcomes satisfy I1/I2, not
 * that one specific outcome always wins.
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

async function createRawSession({ capacity = 5, startsAt = futureDate(48), durationMinutes = 60 } = {}) {
  const [session] = await db('sessions')
    .insert({
      class_id: fixture.class.id,
      primary_instructor_id: fixture.instructor.id,
      room_id: fixture.room.id,
      starts_at: startsAt,
      duration_minutes: durationMinutes,
      capacity,
    })
    .returning('*');
  return session;
}

let memberCounter = 0;
async function createMember() {
  memberCounter += 1;
  const [member] = await db('members')
    .insert({
      full_name: `Booking Concurrency Test Member ${RUN}-${memberCounter}`,
      email: `booking-concurrency-${RUN}-${memberCounter}@example.com`,
      membership_expires_on: '2099-01-01',
    })
    .returning('*');
  return member;
}

function createBooking(cookie, sessionId, memberId) {
  return server.request({
    method: 'POST',
    path: '/api/bookings',
    cookie,
    body: { sessionId: String(sessionId), memberId: String(memberId) },
  });
}

function cancelBooking(cookie, bookingId) {
  return server.request({ method: 'POST', path: `/api/bookings/${bookingId}/cancel`, cookie });
}

async function occupiedCount(sessionId) {
  const [{ count }] = await db('bookings')
    .where({ session_id: sessionId })
    .whereIn('status', ['booked', 'attended', 'no_show'])
    .count({ count: '*' });
  return Number(count);
}

before(async () => {
  server = await startTestServer();
  fixture.staff = await db('users').where({ role: 'staff', is_active: true }).first();
  fixture.instructor = await db('users').where({ role: 'instructor', is_active: true }).first();
  assert.ok(fixture.staff, 'seed data requires an active staff account');
  assert.ok(fixture.instructor, 'seed data requires an active instructor account');

  [fixture.room] = await db('rooms').insert({ name: `Booking Concurrency Test Room ${RUN}` }).returning('*');
  [fixture.class] = await db('classes')
    .insert({
      title: `Booking Concurrency Test Class ${RUN}`,
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

describe('booking concurrency hardening', () => {
  it('1. two simultaneous creates for a capacity-1 session: exactly one booked, one waitlisted', async () => {
    const session = await createRawSession({ capacity: 1 });
    const [memberA, memberB] = await Promise.all([createMember(), createMember()]);
    const cookie = await loginAs(fixture.staff);

    const [resA, resB] = await Promise.all([
      createBooking(cookie, session.id, memberA.id),
      createBooking(cookie, session.id, memberB.id),
    ]);

    assert.ok([resA.status, resB.status].every((s) => s === 201), 'no 500s: both requests must succeed with a decision');
    const statuses = [resA.json.booking.status, resB.json.booking.status].sort();
    assert.deepEqual(statuses, ['booked', 'waitlisted']);

    const occupied = await occupiedCount(session.id);
    assert.equal(occupied, 1, 'I1: occupied must never exceed capacity');
  });

  it('2. ten simultaneous creates for a capacity-3 session: exactly 3 booked, 7 waitlisted, no 500s', async () => {
    const session = await createRawSession({ capacity: 3 });
    const members = await Promise.all(Array.from({ length: 10 }, () => createMember()));
    const cookie = await loginAs(fixture.staff);

    const responses = await Promise.all(members.map((member) => createBooking(cookie, session.id, member.id)));

    assert.ok(responses.every((res) => res.status === 201), `all ten creates must succeed: ${JSON.stringify(responses.map((r) => r.status))}`);
    const statusCounts = responses.reduce(
      (acc, res) => {
        acc[res.json.booking.status] = (acc[res.json.booking.status] ?? 0) + 1;
        return acc;
      },
      {},
    );
    assert.equal(statusCounts.booked, 3);
    assert.equal(statusCounts.waitlisted, 7);

    const occupied = await occupiedCount(session.id);
    assert.equal(occupied, 3, 'I1: occupied must never exceed capacity');
  });

  it('3. two simultaneous creates for the SAME member: exactly one succeeds, the other 409s, exactly one active booking exists', async () => {
    const session = await createRawSession({ capacity: 5 });
    const member = await createMember();
    const cookie = await loginAs(fixture.staff);

    const [resA, resB] = await Promise.all([
      createBooking(cookie, session.id, member.id),
      createBooking(cookie, session.id, member.id),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [201, 409], `expected exactly one 201 and one 409, got ${JSON.stringify([resA.status, resB.status])}`);

    const activeBookings = await db('bookings')
      .where({ session_id: session.id, member_id: member.id })
      .whereIn('status', ['booked', 'waitlisted']);
    assert.equal(activeBookings.length, 1, 'I3: at most one active booking per (session, member)');
  });

  it('4. simultaneous cancellations of two booked bookings each correctly and exclusively promote a waitlisted booking', async () => {
    const session = await createRawSession({ capacity: 2 });
    const members = await Promise.all([1, 2, 3, 4, 5].map(() => createMember()));
    const cookie = await loginAs(fixture.staff);

    const bookings = [];
    for (const member of members) {
      const res = await createBooking(cookie, session.id, member.id);
      assert.equal(res.status, 201, res.raw);
      bookings.push(res.json.booking);
    }
    // capacity 2: first two booked, next three waitlisted (W1, W2, W3) in FIFO order.
    assert.deepEqual(bookings.map((b) => b.status), ['booked', 'booked', 'waitlisted', 'waitlisted', 'waitlisted']);

    const [cancelA, cancelB] = await Promise.all([
      cancelBooking(cookie, bookings[0].id),
      cancelBooking(cookie, bookings[1].id),
    ]);
    assert.equal(cancelA.status, 200, cancelA.raw);
    assert.equal(cancelB.status, 200, cancelB.raw);

    // The session lock serializes the two cancellations; FIFO order makes
    // the result the same regardless of which one the OS runs first: the
    // two earliest-waitlisted bookings (W1, W2) are promoted, W3 is not, and
    // no waitlisted booking is ever promoted twice.
    const promotedIds = new Set(
      [...cancelA.json.promoted, ...cancelB.json.promoted].map((b) => String(b.id)),
    );
    assert.deepEqual(promotedIds, new Set([String(bookings[2].id), String(bookings[3].id)]));

    const rows = await db('bookings').where({ session_id: session.id }).select('id', 'status');
    const byId = Object.fromEntries(rows.map((r) => [String(r.id), r.status]));
    assert.equal(byId[String(bookings[0].id)], 'cancelled');
    assert.equal(byId[String(bookings[1].id)], 'cancelled');
    assert.equal(byId[String(bookings[2].id)], 'booked');
    assert.equal(byId[String(bookings[3].id)], 'booked');
    assert.equal(byId[String(bookings[4].id)], 'waitlisted', 'the third waitlisted booking must not be promoted — only two seats freed');

    const occupied = await occupiedCount(session.id);
    assert.equal(occupied, 2, 'I1: occupied must never exceed capacity');
  });

  it('5. a simultaneous cancellation and a new create never leave two claims on the freed seat', async () => {
    const session = await createRawSession({ capacity: 1 });
    const [holder, waiter, newcomer] = await Promise.all([createMember(), createMember(), createMember()]);
    const cookie = await loginAs(fixture.staff);

    const held = await createBooking(cookie, session.id, holder.id);
    assert.equal(held.status, 201, held.raw);
    const waitlisted = await createBooking(cookie, session.id, waiter.id);
    assert.equal(waitlisted.status, 201, waitlisted.raw);
    assert.equal(waitlisted.json.booking.status, 'waitlisted');

    const [cancelRes, createRes] = await Promise.all([
      cancelBooking(cookie, held.json.booking.id),
      createBooking(cookie, session.id, newcomer.id),
    ]);
    assert.equal(cancelRes.status, 200, cancelRes.raw);
    assert.equal(createRes.status, 201, createRes.raw);

    // `waiter` was waitlisted before either concurrent request began, so
    // FIFO order guarantees it — not `newcomer` — wins the freed seat under
    // either possible interleaving.
    const rows = await db('bookings').where({ session_id: session.id }).select('member_id', 'status');
    const byMember = Object.fromEntries(rows.map((r) => [String(r.member_id), r.status]));
    assert.equal(byMember[String(holder.id)], 'cancelled');
    assert.equal(byMember[String(waiter.id)], 'booked');
    assert.equal(byMember[String(newcomer.id)], 'waitlisted');

    const occupied = await occupiedCount(session.id);
    assert.equal(occupied, 1, 'I1: occupied must never exceed capacity');
  });

  it('6. a simultaneous capacity decrease and a new create never leave the database in a state violating I1', async () => {
    const session = await createRawSession({ capacity: 3 });
    const [h1, h2, newcomer] = await Promise.all([createMember(), createMember(), createMember()]);
    const cookie = await loginAs(fixture.staff);

    const r1 = await createBooking(cookie, session.id, h1.id);
    assert.equal(r1.status, 201, r1.raw);
    const r2 = await createBooking(cookie, session.id, h2.id);
    assert.equal(r2.status, 201, r2.raw);

    // A genuine race with two legitimate outcomes, unlike the scenarios
    // above: decreasing to exactly current occupancy (2) is valid, but if
    // the new create lands first, occupancy becomes 3 and the same decrease
    // is then rejected. Both outcomes are correct; what must hold either way
    // is I1.
    const [patchRes, createRes] = await Promise.all([
      server.request({
        method: 'PATCH',
        path: `/api/sessions/${session.id}`,
        cookie,
        body: { capacity: 2 },
      }),
      createBooking(cookie, session.id, newcomer.id),
    ]);
    assert.ok([200, 409].includes(patchRes.status), `PATCH must cleanly succeed or be rejected, got ${patchRes.status}: ${patchRes.raw}`);
    assert.equal(createRes.status, 201, createRes.raw);

    const sessionRow = await db('sessions').where({ id: session.id }).first();
    const occupied = await occupiedCount(session.id);
    assert.ok(occupied <= sessionRow.capacity, `I1 violated: occupied=${occupied}, capacity=${sessionRow.capacity}`);

    if (patchRes.status === 200) {
      assert.equal(sessionRow.capacity, 2);
      assert.equal(occupied, 2);
      assert.equal(createRes.json.booking.status, 'waitlisted');
    } else {
      assert.equal(sessionRow.capacity, 3);
      assert.equal(occupied, 3);
      assert.equal(createRes.json.booking.status, 'booked');
    }
  });
});
