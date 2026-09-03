import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * The member portal's own booking surface: `GET /api/member/sessions`,
 * `GET/POST /api/member/bookings`, `POST /api/member/bookings/:id/cancel` —
 * and the authorization boundary around it (a member may only ever act on
 * their own linked member record; staff/instructor accounts are denied
 * entirely). Exercised over real HTTP against a running app and a live
 * database, same as every other route-level test file in this project.
 */

let server;
const RUN = Date.now();
const createdUserEmails = [];
let counter = 0;
const fixture = {};

function uniqueEmail(prefix) {
  counter += 1;
  const email = `${prefix}-${RUN}-${counter}@example.test`;
  createdUserEmails.push(email);
  return email;
}

async function signupMember(fullName) {
  const email = uniqueEmail('portal');
  const res = await server.request({
    method: 'POST',
    path: '/api/auth/signup',
    body: { fullName, email, password: 'a-real-password-123' },
  });
  assert.equal(res.status, 201);
  return { email, cookie: res.cookie, userId: res.json.user.id };
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

async function grantMembership(userId, expiresOn) {
  await db('members').where({ user_id: userId }).update({ membership_expires_on: expiresOn });
}

async function createRawSession({ capacity = 5, startsAt, durationMinutes = 60 } = {}) {
  const [session] = await db('sessions')
    .insert({
      class_id: fixture.class.id,
      primary_instructor_id: fixture.instructor.id,
      room_id: fixture.room.id,
      starts_at: startsAt ?? new Date(Date.now() + 24 * 3_600_000),
      duration_minutes: durationMinutes,
      capacity,
    })
    .returning('*');
  return session;
}

before(async () => {
  server = await startTestServer();

  fixture.staff = await db('users').where({ role: 'staff', is_active: true }).first();
  fixture.instructor = await db('users').where({ role: 'instructor', is_active: true }).first();
  [fixture.room] = await db('rooms').insert({ name: `Member Portal Test Room ${RUN}` }).returning('*');
  [fixture.class] = await db('classes')
    .insert({
      title: `Member Portal Test Class ${RUN}`,
      discipline: 'Testing',
      default_duration_minutes: 60,
      default_capacity: 5,
    })
    .returning('*');
});

// No fixture cleanup here, deliberately: every member created in this file
// books (and most cancel) a real session, which writes `booking_events` rows
// whose `actor_user_id` is that member's own user id — `ON DELETE RESTRICT`
// (see `schema.test.js`) makes such a user permanently undeletable, and
// `booking_events` itself rejects DELETE outright (append-only, goal 9).
// Same "unique per run, never cleaned up" fixture pattern `tests/bookings.
// test.js` already uses for exactly this reason, not an oversight.
after(async () => {
  await server.stop();
  await closeConnection();
});

describe('GET /api/member/sessions', () => {
  it('lists an upcoming session with class/instructor/room/capacity/availability', async () => {
    const session = await createRawSession({ capacity: 2 });
    const { cookie } = await signupMember('Session Browser');

    const res = await server.request({ method: 'GET', path: '/api/member/sessions', cookie });
    assert.equal(res.status, 200);
    const found = res.json.sessions.find((row) => String(row.id) === String(session.id));
    assert.ok(found, 'the session appears in the member-facing list');
    assert.equal(found.class.title, fixture.class.title);
    assert.equal(found.room.name, fixture.room.name);
    assert.equal(found.instructor.fullName, fixture.instructor.full_name);
    assert.equal(found.capacity, 2);
    assert.equal(found.bookedCount, 0);
    assert.equal(found.isFull, false);
  });

  it('is denied entirely for staff and instructor accounts', async () => {
    const staffCookie = await loginAs(fixture.staff);
    const staffRes = await server.request({ method: 'GET', path: '/api/member/sessions', cookie: staffCookie });
    assert.equal(staffRes.status, 403);

    const instructorCookie = await loginAs(fixture.instructor);
    const instructorRes = await server.request({
      method: 'GET',
      path: '/api/member/sessions',
      cookie: instructorCookie,
    });
    assert.equal(instructorRes.status, 403);
  });

  it('requires authentication', async () => {
    const res = await server.request({ method: 'GET', path: '/api/member/sessions' });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/member/bookings', () => {
  it('books the session for the caller’s own linked member — memberId is never accepted from the client', async () => {
    const session = await createRawSession({ capacity: 5 });
    const { cookie, userId } = await signupMember('Self Booker');
    await grantMembership(userId, '2099-01-01');

    const otherMember = await db('members').whereNot({ user_id: userId }).first();
    const res = await server.request({
      method: 'POST',
      path: '/api/member/bookings',
      cookie,
      // A memberId in the body, even a real one belonging to someone else,
      // has no field to land in — the schema only accepts `sessionId`.
      body: { sessionId: session.id, memberId: otherMember?.id },
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.booking.status, 'booked');

    const own = await db('members').where({ user_id: userId }).first();
    const row = await db('bookings').where({ id: res.json.booking.id }).first();
    assert.equal(String(row.member_id), String(own.id), 'the booking belongs to the caller’s own member, never another one');
  });

  it('rejects a new booking when the caller’s membership has expired', async () => {
    const session = await createRawSession({ capacity: 5 });
    const { cookie, userId } = await signupMember('Expired Membership');
    await grantMembership(userId, '2000-01-01');

    const res = await server.request({
      method: 'POST',
      path: '/api/member/bookings',
      cookie,
      body: { sessionId: session.id },
    });
    assert.equal(res.status, 409);
    assert.doesNotMatch(res.raw, /stack|SQLSTATE/i);
  });

  it('rejects a new booking for a brand-new signup that was never granted a real membership (no grantMembership call at all)', async () => {
    const session = await createRawSession({ capacity: 5 });
    // Deliberately no `grantMembership` — this member has exactly what
    // `domain/memberLinking.js` gave it at signup, nothing more.
    const { cookie } = await signupMember('No Membership Yet');

    const res = await server.request({
      method: 'POST',
      path: '/api/member/bookings',
      cookie,
      body: { sessionId: session.id },
    });
    assert.equal(res.status, 409);
  });

  it('waitlists once the session is full, reusing the same capacity rule staff bookings use', async () => {
    const session = await createRawSession({ capacity: 1 });
    const filler = await signupMember('Seat Filler');
    await grantMembership(filler.userId, '2099-01-01');
    const fillRes = await server.request({
      method: 'POST',
      path: '/api/member/bookings',
      cookie: filler.cookie,
      body: { sessionId: session.id },
    });
    assert.equal(fillRes.json.booking.status, 'booked');

    const waitlisted = await signupMember('Waitlisted Member');
    await grantMembership(waitlisted.userId, '2099-01-01');
    const res = await server.request({
      method: 'POST',
      path: '/api/member/bookings',
      cookie: waitlisted.cookie,
      body: { sessionId: session.id },
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.booking.status, 'waitlisted');
  });

  it('is denied entirely for a staff account', async () => {
    const session = await createRawSession({ capacity: 5 });
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'POST',
      path: '/api/member/bookings',
      cookie,
      body: { sessionId: session.id },
    });
    assert.equal(res.status, 403);
  });
});

describe('GET /api/member/bookings', () => {
  it('lists only the caller’s own bookings, never another member’s', async () => {
    const session = await createRawSession({ capacity: 5 });
    const a = await signupMember('Bookings List A');
    await grantMembership(a.userId, '2099-01-01');
    const b = await signupMember('Bookings List B');
    await grantMembership(b.userId, '2099-01-01');

    await server.request({ method: 'POST', path: '/api/member/bookings', cookie: a.cookie, body: { sessionId: session.id } });

    const resA = await server.request({ method: 'GET', path: '/api/member/bookings', cookie: a.cookie });
    assert.equal(resA.status, 200);
    assert.equal(resA.json.bookings.length, 1);

    const resB = await server.request({ method: 'GET', path: '/api/member/bookings', cookie: b.cookie });
    assert.equal(resB.status, 200);
    assert.equal(resB.json.bookings.length, 0, 'member B sees none of member A’s bookings');
  });
});

describe('POST /api/member/bookings/:id/cancel', () => {
  it('cancels the caller’s own eligible booking', async () => {
    const session = await createRawSession({ capacity: 5 });
    const { cookie, userId } = await signupMember('Self Canceller');
    await grantMembership(userId, '2099-01-01');
    const created = await server.request({
      method: 'POST',
      path: '/api/member/bookings',
      cookie,
      body: { sessionId: session.id },
    });

    const res = await server.request({
      method: 'POST',
      path: `/api/member/bookings/${created.json.booking.id}/cancel`,
      cookie,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.booking.status, 'cancelled');
  });

  it('cannot cancel another member’s booking — reports 404, not 403, so existence is never confirmed', async () => {
    const session = await createRawSession({ capacity: 5 });
    const owner = await signupMember('Booking Owner');
    await grantMembership(owner.userId, '2099-01-01');
    const created = await server.request({
      method: 'POST',
      path: '/api/member/bookings',
      cookie: owner.cookie,
      body: { sessionId: session.id },
    });

    const attacker = await signupMember('Not The Owner');
    await grantMembership(attacker.userId, '2099-01-01');
    const res = await server.request({
      method: 'POST',
      path: `/api/member/bookings/${created.json.booking.id}/cancel`,
      cookie: attacker.cookie,
    });
    assert.equal(res.status, 404);

    const stillActive = await db('bookings').where({ id: created.json.booking.id }).first();
    assert.equal(stillActive.status, 'booked', 'the real owner’s booking was untouched');
  });

  it('is denied entirely for an instructor account', async () => {
    const cookie = await loginAs(fixture.instructor);
    const res = await server.request({ method: 'POST', path: '/api/member/bookings/999999/cancel', cookie });
    assert.equal(res.status, 403);
  });
});
