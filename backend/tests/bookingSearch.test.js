import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Goal 6 — `GET /api/bookings` search, filter, sort, pagination and total
 * count, all performed server-side in PostgreSQL. Run over real HTTP against
 * a running app and a live database.
 *
 * Two classes and two sessions with two different primary instructors
 * (`sessionA`/instructorA, `sessionB`/instructorB) are the backbone fixture:
 * most tests here are really asking one question in different shapes — "can
 * anything instructor A supplies in the query string make instructor B's
 * booking appear?" — and that question needs two genuinely separate
 * instructor scopes to be meaningful at all.
 *
 * Fixture data is created once per run with a unique `RUN` suffix and never
 * deleted (same reasoning as `bookings.test.js`: a session with any booking
 * attached is permanently undeletable by design), so every test that asserts
 * an *exact* result set scopes itself with `sessionId`/`classId` rather than
 * asserting against the whole table, and pagination tests use `pageSize=100`
 * or a small dedicated session to stay deterministic across repeated runs.
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

async function createSession({ instructorId, classId, roomId, capacity = 5, startsAt = futureDate(24), durationMinutes = 60 }) {
  const [session] = await db('sessions')
    .insert({
      class_id: classId,
      primary_instructor_id: instructorId,
      room_id: roomId,
      starts_at: startsAt,
      duration_minutes: durationMinutes,
      capacity,
    })
    .returning('*');
  return session;
}

let memberCounter = 0;
async function createMember(overrides = {}) {
  memberCounter += 1;
  const [member] = await db('members')
    .insert({
      full_name: overrides.fullName ?? `Search Test Member ${RUN}-${memberCounter}`,
      email: overrides.email ?? `search-test-${RUN}-${memberCounter}@example.com`,
      membership_expires_on: overrides.expiresOn ?? '2099-01-01',
    })
    .returning('*');
  return member;
}

async function bookViaApi(cookie, sessionId, memberId) {
  const res = await server.request({
    method: 'POST',
    path: '/api/bookings',
    cookie,
    body: { sessionId: String(sessionId), memberId: String(memberId) },
  });
  assert.equal(res.status, 201, res.raw);
  return res.json.booking;
}

function listBookings(cookie, query = '') {
  return server.request({ method: 'GET', path: `/api/bookings${query}`, cookie });
}

before(async () => {
  server = await startTestServer();

  fixture.staff = await db('users').where({ role: 'staff', is_active: true }).first();
  const instructors = await db('users').where({ role: 'instructor', is_active: true }).select('*');
  assert.ok(instructors.length >= 3, 'seed data requires at least three active instructors');
  [fixture.instructorA, fixture.instructorB, fixture.instructorC] = instructors;

  [fixture.room] = await db('rooms').insert({ name: `Search Test Room ${RUN}` }).returning('*');
  [fixture.classA] = await db('classes')
    .insert({
      title: `Search Test Class A ${RUN}`,
      discipline: 'Testing',
      default_duration_minutes: 60,
      default_capacity: 5,
    })
    .returning('*');
  [fixture.classB] = await db('classes')
    .insert({
      title: `Search Test Class B ${RUN}`,
      discipline: 'Testing',
      default_duration_minutes: 60,
      default_capacity: 5,
    })
    .returning('*');

  fixture.sessionA = await createSession({
    instructorId: fixture.instructorA.id,
    classId: fixture.classA.id,
    roomId: fixture.room.id,
  });
  fixture.sessionB = await createSession({
    instructorId: fixture.instructorB.id,
    classId: fixture.classB.id,
    roomId: fixture.room.id,
  });
});

after(async () => {
  await server.stop();
  await closeConnection();
});

describe('GET /api/bookings — authentication', () => {
  it('denies an unauthenticated request', async () => {
    const res = await server.request({ method: 'GET', path: '/api/bookings' });
    assert.equal(res.status, 401);
  });
});

describe('GET /api/bookings — base visibility by role', () => {
  it('staff sees bookings from both instructors’ sessions', async () => {
    const memberA = await createMember();
    const memberB = await createMember();
    const staffCookie = await loginAs(fixture.staff);
    const bookingA = await bookViaApi(staffCookie, fixture.sessionA.id, memberA.id);
    const bookingB = await bookViaApi(staffCookie, fixture.sessionB.id, memberB.id);

    const res = await listBookings(staffCookie, '?pageSize=100');
    assert.equal(res.status, 200, res.raw);
    const ids = new Set(res.json.bookings.map((b) => String(b.id)));
    assert.ok(ids.has(String(bookingA.id)));
    assert.ok(ids.has(String(bookingB.id)));
  });

  it('the primary instructor sees a booking for their own session', async () => {
    const member = await createMember();
    const staffCookie = await loginAs(fixture.staff);
    const booking = await bookViaApi(staffCookie, fixture.sessionA.id, member.id);

    const cookieA = await loginAs(fixture.instructorA);
    const res = await listBookings(cookieA, `?sessionId=${fixture.sessionA.id}`);
    assert.equal(res.status, 200, res.raw);
    const ids = res.json.bookings.map((b) => String(b.id));
    assert.ok(ids.includes(String(booking.id)));
  });

  it('a co-instructor sees bookings for a session they are added to; an unrelated instructor does not', async () => {
    const coSession = await createSession({
      instructorId: fixture.instructorA.id,
      classId: fixture.classA.id,
      roomId: fixture.room.id,
    });
    await db('session_co_instructors').insert({
      session_id: coSession.id,
      user_id: fixture.instructorC.id,
      session_primary_instructor_id: coSession.primary_instructor_id,
    });

    const member = await createMember();
    const staffCookie = await loginAs(fixture.staff);
    const booking = await bookViaApi(staffCookie, coSession.id, member.id);

    const coCookie = await loginAs(fixture.instructorC);
    const coRes = await listBookings(coCookie, `?sessionId=${coSession.id}`);
    assert.equal(coRes.status, 200, coRes.raw);
    assert.equal(coRes.json.bookings.length, 1);
    assert.equal(String(coRes.json.bookings[0].id), String(booking.id));

    const unrelatedCookie = await loginAs(fixture.instructorB);
    const unrelatedRes = await listBookings(unrelatedCookie, `?sessionId=${coSession.id}`);
    assert.equal(unrelatedRes.status, 200, unrelatedRes.raw);
    assert.equal(unrelatedRes.json.bookings.length, 0);
  });

  it('an unrelated instructor sees zero bookings for another instructor’s session, even unfiltered', async () => {
    const member = await createMember();
    const staffCookie = await loginAs(fixture.staff);
    const booking = await bookViaApi(staffCookie, fixture.sessionB.id, member.id);

    const cookieA = await loginAs(fixture.instructorA);
    const res = await listBookings(cookieA, '?pageSize=100');
    assert.equal(res.status, 200, res.raw);
    const ids = res.json.bookings.map((b) => String(b.id));
    assert.equal(ids.includes(String(booking.id)), false);
  });
});

describe('GET /api/bookings — critical OR-condition: text search cannot widen instructor scope', () => {
  it('instructor A searching for a member visible only in instructor B’s session gets zero results', async () => {
    const memberB = await createMember({ fullName: `Only Visible To B Name ${RUN}` });
    const staffCookie = await loginAs(fixture.staff);
    await bookViaApi(staffCookie, fixture.sessionB.id, memberB.id);

    const cookieA = await loginAs(fixture.instructorA);
    const res = await listBookings(cookieA, `?q=${encodeURIComponent(memberB.full_name)}`);
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(res.json.bookings, []);
    assert.equal(res.json.pagination.total, 0);
  });

  it('instructor A searching for instructor B’s member by email gets zero results', async () => {
    const memberB = await createMember();
    const staffCookie = await loginAs(fixture.staff);
    await bookViaApi(staffCookie, fixture.sessionB.id, memberB.id);

    const cookieA = await loginAs(fixture.instructorA);
    const res = await listBookings(cookieA, `?q=${encodeURIComponent(memberB.email)}`);
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(res.json.bookings, []);
  });

  it('instructor A searching for their own member finds only their own booking', async () => {
    const memberA = await createMember({ fullName: `Only Visible To A Name ${RUN}` });
    const staffCookie = await loginAs(fixture.staff);
    const booking = await bookViaApi(staffCookie, fixture.sessionA.id, memberA.id);

    const cookieA = await loginAs(fixture.instructorA);
    const res = await listBookings(cookieA, `?q=${encodeURIComponent(memberA.full_name)}`);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.bookings.length, 1);
    assert.equal(String(res.json.bookings[0].id), String(booking.id));
  });
});

describe('GET /api/bookings — IDOR: filters cannot widen instructor scope', () => {
  it('classId scoped to another instructor’s class returns zero results', async () => {
    const memberB = await createMember();
    const staffCookie = await loginAs(fixture.staff);
    await bookViaApi(staffCookie, fixture.sessionB.id, memberB.id);

    const cookieA = await loginAs(fixture.instructorA);
    const res = await listBookings(cookieA, `?classId=${fixture.classB.id}`);
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(res.json.bookings, []);
    assert.equal(res.json.pagination.total, 0);
  });

  it('sessionId scoped to another instructor’s session returns zero results', async () => {
    const memberB = await createMember();
    const staffCookie = await loginAs(fixture.staff);
    await bookViaApi(staffCookie, fixture.sessionB.id, memberB.id);

    const cookieA = await loginAs(fixture.instructorA);
    const res = await listBookings(cookieA, `?sessionId=${fixture.sessionB.id}`);
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(res.json.bookings, []);
  });

  it('status filter never surfaces another instructor’s booking of that status', async () => {
    const memberA = await createMember();
    const memberB = await createMember();
    const staffCookie = await loginAs(fixture.staff);
    const bookingA = await bookViaApi(staffCookie, fixture.sessionA.id, memberA.id);
    const bookingB = await bookViaApi(staffCookie, fixture.sessionB.id, memberB.id);

    const cookieA = await loginAs(fixture.instructorA);

    // Narrowed to instructor A's own session: bookingA must be present,
    // bookingB must not.
    const scoped = await listBookings(cookieA, `?sessionId=${fixture.sessionA.id}&status=booked`);
    assert.equal(scoped.status, 200, scoped.raw);
    const scopedIds = scoped.json.bookings.map((b) => String(b.id));
    assert.ok(scopedIds.includes(String(bookingA.id)));
    assert.equal(scopedIds.includes(String(bookingB.id)), false);

    // Unnarrowed (every session instructor A can see, across this whole
    // test file's fixtures): bookingB — belonging to instructor B's session
    // — must never appear, regardless of how many of instructor A's own
    // sessions exist alongside it.
    const wide = await listBookings(cookieA, '?status=booked&pageSize=100');
    assert.equal(wide.status, 200, wide.raw);
    const wideIds = wide.json.bookings.map((b) => String(b.id));
    assert.equal(wideIds.includes(String(bookingB.id)), false);
  });

  it('combining search, class, session and status filters at once cannot bypass authorization', async () => {
    const memberB = await createMember({ fullName: `Combo Search Name ${RUN}` });
    const staffCookie = await loginAs(fixture.staff);
    await bookViaApi(staffCookie, fixture.sessionB.id, memberB.id);

    const cookieA = await loginAs(fixture.instructorA);
    const res = await listBookings(
      cookieA,
      `?q=${encodeURIComponent(memberB.full_name)}&classId=${fixture.classB.id}&sessionId=${fixture.sessionB.id}&status=booked`,
    );
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(res.json.bookings, []);
  });
});

describe('GET /api/bookings — text search', () => {
  it('matches full name, case-insensitively', async () => {
    const member = await createMember({ fullName: `Zzyx Uniqueson ${RUN}` });
    const staffCookie = await loginAs(fixture.staff);
    const booking = await bookViaApi(staffCookie, fixture.sessionA.id, member.id);

    const res = await listBookings(staffCookie, `?q=${encodeURIComponent('zzyx uniqueson')}`);
    assert.equal(res.status, 200, res.raw);
    assert.ok(res.json.bookings.some((b) => String(b.id) === String(booking.id)));
  });

  it('matches a partial name', async () => {
    const member = await createMember({ fullName: `Wobbleton Partialmatch ${RUN}` });
    const staffCookie = await loginAs(fixture.staff);
    const booking = await bookViaApi(staffCookie, fixture.sessionA.id, member.id);

    const res = await listBookings(staffCookie, `?q=${encodeURIComponent('Partialmatch')}`);
    assert.equal(res.status, 200, res.raw);
    assert.ok(res.json.bookings.some((b) => String(b.id) === String(booking.id)));
  });

  it('matches email', async () => {
    const member = await createMember({ email: `unique-email-match-${RUN}@example.com` });
    const staffCookie = await loginAs(fixture.staff);
    const booking = await bookViaApi(staffCookie, fixture.sessionA.id, member.id);

    const res = await listBookings(staffCookie, `?q=${encodeURIComponent(`unique-email-match-${RUN}`)}`);
    assert.equal(res.status, 200, res.raw);
    assert.ok(res.json.bookings.some((b) => String(b.id) === String(booking.id)));
  });

  it('returns no results for a non-matching term', async () => {
    const staffCookie = await loginAs(fixture.staff);
    const res = await listBookings(staffCookie, `?q=${encodeURIComponent(`no-such-member-${RUN}`)}`);
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(res.json.bookings, []);
    assert.equal(res.json.pagination.total, 0);
    assert.equal(res.json.pagination.totalPages, 0);
  });

  it('treats an empty or whitespace-only search term as absent', async () => {
    const staffCookie = await loginAs(fixture.staff);
    const unfiltered = await listBookings(staffCookie, `?sessionId=${fixture.sessionA.id}`);
    const emptyQ = await listBookings(staffCookie, `?sessionId=${fixture.sessionA.id}&q=`);
    const whitespaceQ = await listBookings(
      staffCookie,
      `?sessionId=${fixture.sessionA.id}&q=${encodeURIComponent('   ')}`,
    );
    assert.equal(emptyQ.json.pagination.total, unfiltered.json.pagination.total);
    assert.equal(whitespaceQ.json.pagination.total, unfiltered.json.pagination.total);
  });
});

describe('GET /api/bookings — filters', () => {
  it('filters by classId', async () => {
    const memberA = await createMember();
    const memberB = await createMember();
    const staffCookie = await loginAs(fixture.staff);
    const bookingA = await bookViaApi(staffCookie, fixture.sessionA.id, memberA.id);
    const bookingB = await bookViaApi(staffCookie, fixture.sessionB.id, memberB.id);

    const res = await listBookings(staffCookie, `?classId=${fixture.classA.id}&pageSize=100`);
    assert.equal(res.status, 200, res.raw);
    const ids = res.json.bookings.map((b) => String(b.id));
    assert.ok(ids.includes(String(bookingA.id)));
    assert.equal(ids.includes(String(bookingB.id)), false);
  });

  it('filters by sessionId', async () => {
    const memberA = await createMember();
    const staffCookie = await loginAs(fixture.staff);
    const bookingA = await bookViaApi(staffCookie, fixture.sessionA.id, memberA.id);

    const res = await listBookings(staffCookie, `?sessionId=${fixture.sessionA.id}`);
    assert.equal(res.status, 200, res.raw);
    for (const booking of res.json.bookings) {
      assert.equal(String(booking.sessionId), String(fixture.sessionA.id));
    }
    assert.ok(res.json.bookings.some((b) => String(b.id) === String(bookingA.id)));
  });

  it('filters by status', async () => {
    const session = await createSession({
      instructorId: fixture.instructorA.id,
      classId: fixture.classA.id,
      roomId: fixture.room.id,
      capacity: 5,
    });
    const [keep, cancel] = await Promise.all([createMember(), createMember()]);
    const staffCookie = await loginAs(fixture.staff);
    const kept = await bookViaApi(staffCookie, session.id, keep.id);
    const cancelled = await bookViaApi(staffCookie, session.id, cancel.id);
    const cancelRes = await server.request({
      method: 'POST',
      path: `/api/bookings/${cancelled.id}/cancel`,
      cookie: staffCookie,
    });
    assert.equal(cancelRes.status, 200, cancelRes.raw);

    const bookedRes = await listBookings(staffCookie, `?sessionId=${session.id}&status=booked`);
    assert.deepEqual(
      bookedRes.json.bookings.map((b) => String(b.id)),
      [String(kept.id)],
    );

    const cancelledRes = await listBookings(staffCookie, `?sessionId=${session.id}&status=cancelled`);
    assert.deepEqual(
      cancelledRes.json.bookings.map((b) => String(b.id)),
      [String(cancelled.id)],
    );
  });

  it('rejects an invalid status with 400', async () => {
    const staffCookie = await loginAs(fixture.staff);
    const res = await listBookings(staffCookie, '?status=bogus');
    assert.equal(res.status, 400, res.raw);
  });

  it('rejects a malformed classId with 400', async () => {
    const staffCookie = await loginAs(fixture.staff);
    const res = await listBookings(staffCookie, '?classId=not-an-id');
    assert.equal(res.status, 400, res.raw);
  });

  it('rejects a malformed sessionId with 400', async () => {
    const staffCookie = await loginAs(fixture.staff);
    const res = await listBookings(staffCookie, '?sessionId=not-an-id');
    assert.equal(res.status, 400, res.raw);
  });

  it('combines class and status filters', async () => {
    const session = await createSession({
      instructorId: fixture.instructorA.id,
      classId: fixture.classA.id,
      roomId: fixture.room.id,
      capacity: 5,
    });
    const member = await createMember();
    const staffCookie = await loginAs(fixture.staff);
    const booking = await bookViaApi(staffCookie, session.id, member.id);

    const res = await listBookings(
      staffCookie,
      `?classId=${fixture.classA.id}&sessionId=${session.id}&status=booked`,
    );
    assert.equal(res.status, 200, res.raw);
    assert.ok(res.json.bookings.some((b) => String(b.id) === String(booking.id)));

    const noMatch = await listBookings(
      staffCookie,
      `?classId=${fixture.classB.id}&sessionId=${session.id}&status=booked`,
    );
    assert.deepEqual(noMatch.json.bookings, []);
  });
});

describe('GET /api/bookings — sorting', () => {
  it('sorts by bookedAt ascending and descending', async () => {
    const session = await createSession({
      instructorId: fixture.instructorA.id,
      classId: fixture.classA.id,
      roomId: fixture.room.id,
      capacity: 5,
    });
    const members = await Promise.all([1, 2, 3].map(() => createMember()));
    const staffCookie = await loginAs(fixture.staff);
    const bookings = [];
    for (const member of members) {
      bookings.push(await bookViaApi(staffCookie, session.id, member.id));
    }

    const asc = await listBookings(staffCookie, `?sessionId=${session.id}&sort=bookedAt&direction=asc`);
    assert.deepEqual(
      asc.json.bookings.map((b) => String(b.id)),
      bookings.map((b) => String(b.id)),
    );

    const desc = await listBookings(staffCookie, `?sessionId=${session.id}&sort=bookedAt&direction=desc`);
    assert.deepEqual(
      desc.json.bookings.map((b) => String(b.id)),
      [...bookings].reverse().map((b) => String(b.id)),
    );
  });

  it('sorts by status ascending and descending (enum lifecycle order)', async () => {
    const session = await createSession({
      instructorId: fixture.instructorA.id,
      classId: fixture.classA.id,
      roomId: fixture.room.id,
      capacity: 5,
    });
    const [bookedMember, cancelMember] = await Promise.all([createMember(), createMember()]);
    const staffCookie = await loginAs(fixture.staff);
    const booked = await bookViaApi(staffCookie, session.id, bookedMember.id);
    const toCancel = await bookViaApi(staffCookie, session.id, cancelMember.id);
    const cancelRes = await server.request({
      method: 'POST',
      path: `/api/bookings/${toCancel.id}/cancel`,
      cookie: staffCookie,
    });
    assert.equal(cancelRes.status, 200, cancelRes.raw);

    // Enum declaration order (schema.md): booked, waitlisted, cancelled, attended, no_show.
    const asc = await listBookings(staffCookie, `?sessionId=${session.id}&sort=status&direction=asc`);
    assert.deepEqual(
      asc.json.bookings.map((b) => [b.id, b.status]),
      [[String(booked.id), 'booked'], [String(toCancel.id), 'cancelled']],
    );

    const desc = await listBookings(staffCookie, `?sessionId=${session.id}&sort=status&direction=desc`);
    assert.deepEqual(
      desc.json.bookings.map((b) => b.status),
      ['cancelled', 'booked'],
    );
  });

  it('sorts by session start time ascending and descending', async () => {
    const earlySession = await createSession({
      instructorId: fixture.instructorA.id,
      classId: fixture.classA.id,
      roomId: fixture.room.id,
      startsAt: futureDate(10),
    });
    const lateSession = await createSession({
      instructorId: fixture.instructorA.id,
      classId: fixture.classA.id,
      roomId: fixture.room.id,
      startsAt: futureDate(100),
    });
    const [earlyMember, lateMember] = await Promise.all([createMember(), createMember()]);
    const staffCookie = await loginAs(fixture.staff);
    const earlyBooking = await bookViaApi(staffCookie, earlySession.id, earlyMember.id);
    const lateBooking = await bookViaApi(staffCookie, lateSession.id, lateMember.id);

    const asc = await listBookings(
      staffCookie,
      `?classId=${fixture.classA.id}&sort=session&direction=asc&pageSize=100`,
    );
    const ascIds = asc.json.bookings.map((b) => String(b.id));
    assert.ok(ascIds.indexOf(String(earlyBooking.id)) < ascIds.indexOf(String(lateBooking.id)));

    const desc = await listBookings(
      staffCookie,
      `?classId=${fixture.classA.id}&sort=session&direction=desc&pageSize=100`,
    );
    const descIds = desc.json.bookings.map((b) => String(b.id));
    assert.ok(descIds.indexOf(String(lateBooking.id)) < descIds.indexOf(String(earlyBooking.id)));
  });

  it('rejects an unknown sort field with 400', async () => {
    const staffCookie = await loginAs(fixture.staff);
    const res = await listBookings(staffCookie, '?sort=bogus');
    assert.equal(res.status, 400, res.raw);
  });

  it('rejects an invalid direction with 400', async () => {
    const staffCookie = await loginAs(fixture.staff);
    const res = await listBookings(staffCookie, '?direction=bogus');
    assert.equal(res.status, 400, res.raw);
  });

  it('appends a deterministic id tiebreaker so rows with an equal primary sort value have a stable order', async () => {
    const session = await createSession({
      instructorId: fixture.instructorA.id,
      classId: fixture.classA.id,
      roomId: fixture.room.id,
      capacity: 5,
    });
    const members = await Promise.all([1, 2, 3].map(() => createMember()));
    const staffCookie = await loginAs(fixture.staff);
    const bookings = [];
    for (const member of members) {
      bookings.push(await bookViaApi(staffCookie, session.id, member.id));
    }
    // All three share the same status, so sorting by status must fall back to
    // `bookings.id ASC` regardless of the requested direction.
    const desc = await listBookings(staffCookie, `?sessionId=${session.id}&sort=status&direction=desc`);
    assert.deepEqual(
      desc.json.bookings.map((b) => String(b.id)),
      bookings.map((b) => String(b.id)),
    );
    const asc = await listBookings(staffCookie, `?sessionId=${session.id}&sort=status&direction=asc`);
    assert.deepEqual(
      asc.json.bookings.map((b) => String(b.id)),
      bookings.map((b) => String(b.id)),
    );
  });
});

describe('GET /api/bookings — pagination', () => {
  it('splits results across pages and returns the same total on every page', async () => {
    const session = await createSession({
      instructorId: fixture.instructorA.id,
      classId: fixture.classA.id,
      roomId: fixture.room.id,
      capacity: 10,
    });
    const members = await Promise.all([1, 2, 3, 4, 5].map(() => createMember()));
    const staffCookie = await loginAs(fixture.staff);
    const bookings = [];
    for (const member of members) {
      bookings.push(await bookViaApi(staffCookie, session.id, member.id));
    }

    const query = (page) =>
      `?sessionId=${session.id}&pageSize=2&page=${page}&sort=bookedAt&direction=asc`;

    const page1 = await listBookings(staffCookie, query(1));
    assert.equal(page1.json.bookings.length, 2);
    assert.equal(page1.json.pagination.total, 5);
    assert.equal(page1.json.pagination.totalPages, 3);

    const page2 = await listBookings(staffCookie, query(2));
    assert.equal(page2.json.bookings.length, 2);
    assert.equal(page2.json.pagination.total, 5);

    const page3 = await listBookings(staffCookie, query(3));
    assert.equal(page3.json.bookings.length, 1);
    assert.equal(page3.json.pagination.total, 5);
    assert.equal(page3.json.pagination.totalPages, 3);

    const allIds = [...page1.json.bookings, ...page2.json.bookings, ...page3.json.bookings].map((b) =>
      String(b.id),
    );
    assert.deepEqual(allIds, bookings.map((b) => String(b.id)));
  });

  it('a page beyond the last page returns no rows but still reports the correct total', async () => {
    const session = await createSession({
      instructorId: fixture.instructorA.id,
      classId: fixture.classA.id,
      roomId: fixture.room.id,
      capacity: 5,
    });
    const members = await Promise.all([1, 2].map(() => createMember()));
    const staffCookie = await loginAs(fixture.staff);
    for (const member of members) {
      await bookViaApi(staffCookie, session.id, member.id);
    }

    const res = await listBookings(staffCookie, `?sessionId=${session.id}&pageSize=2&page=5`);
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(res.json.bookings, []);
    assert.equal(res.json.pagination.total, 2);
    assert.equal(res.json.pagination.totalPages, 1);
  });

  it('rejects an invalid page value', async () => {
    const staffCookie = await loginAs(fixture.staff);
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const res = await listBookings(staffCookie, `?page=${bad}`);
      assert.equal(res.status, 400, `page=${bad} should be rejected`);
    }
  });

  it('rejects an invalid pageSize value and enforces the maximum', async () => {
    const staffCookie = await loginAs(fixture.staff);
    for (const bad of ['0', '-1', 'abc', '1.5', '101']) {
      const res = await listBookings(staffCookie, `?pageSize=${bad}`);
      assert.equal(res.status, 400, `pageSize=${bad} should be rejected`);
    }
    const atMax = await listBookings(staffCookie, '?pageSize=100');
    assert.equal(atMax.status, 200, atMax.raw);
  });
});

describe('GET /api/bookings — total count', () => {
  it('total reflects every matching row, not just the current page', async () => {
    const session = await createSession({
      instructorId: fixture.instructorA.id,
      classId: fixture.classA.id,
      roomId: fixture.room.id,
      capacity: 5,
    });
    const members = await Promise.all([1, 2, 3].map(() => createMember()));
    const staffCookie = await loginAs(fixture.staff);
    for (const member of members) {
      await bookViaApi(staffCookie, session.id, member.id);
    }

    const res = await listBookings(staffCookie, `?sessionId=${session.id}&pageSize=1`);
    assert.equal(res.json.bookings.length, 1);
    assert.equal(res.json.pagination.total, 3);
  });

  it('empty result convention: bookings is [], total is 0, totalPages is 0', async () => {
    const staffCookie = await loginAs(fixture.staff);
    const res = await listBookings(staffCookie, `?q=${encodeURIComponent(`no-such-member-at-all-${RUN}`)}`);
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(res.json.bookings, []);
    assert.equal(res.json.pagination.total, 0);
    assert.equal(res.json.pagination.totalPages, 0);
  });
});
