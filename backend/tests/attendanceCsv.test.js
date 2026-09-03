import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Goal 7, part B — `GET /api/sessions/:sessionId/attendance.csv`, exercised
 * over real HTTP against a running app and a live database.
 *
 * Fixture room/class are created once and never deleted — the moment a
 * session here carries a real booking it becomes permanently undeletable
 * (`bookings.session_id` is `ON DELETE RESTRICT`, `booking_events` is
 * append-only), the same reasoning `bookings.test.js` already documents —
 * so a unique `RUN` suffix, not `after()` cleanup, is what keeps repeated
 * runs from colliding.
 */

let server;
const RUN = Date.now();
const fixture = {};
let memberCounter = 0;

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

// A far-future, randomized window — not `Date.now() + smallOffset` — for the
// same reason `sessions.test.js`/`coInstructors.test.js` use one: the demo
// seed schedules its own sessions within roughly -21..+16 days of "today"
// (`seeds/001_demo_data.js`), and this file's co-instructor-add calls go
// through the real conflict-checked endpoint (unlike its raw-inserted
// sessions), so landing inside the seed's window risks a spurious instructor
// conflict against seeded data.
//
// Every session in this file ends up carrying a real booking, so — unlike
// most of `sessions.test.js`'s fixtures — none of them are ever deleted;
// each run leaves its own permanent instructor-conflict "footprint" behind
// (`sessions.test.js`'s `p6Base` documents the same fact for its own
// booking-carrying fixtures). A narrow random range is not enough to avoid
// that footprint: every session in one run sits at a *fixed* offset (0h,
// 48h, 72h, 96h, 120h) from that run's own `WINDOW_START`, so two runs
// collide whenever their `WINDOW_START`s merely differ by one of those same
// offsets, not only when they coincide outright — a far larger effective
// collision surface than it first looks. The fix is the same ratio
// `p6Base` relies on: keep the random range wide relative to the small
// offsets used within one run, so the chance of ever landing on a prior
// run's footprint (or another suite's fixed window) stays negligible.
const WINDOW_START = new Date(
  Date.now() + (50_000 + Math.floor(Math.random() * 400_000)) * 3_600_000,
);

function futureDate(hoursFromWindowStart) {
  return new Date(WINDOW_START.getTime() + hoursFromWindowStart * 3_600_000);
}

async function createMember(overrides = {}) {
  memberCounter += 1;
  const [member] = await db('members')
    .insert({
      full_name: `Attendance Test Member ${RUN}-${memberCounter}`,
      email: `attendance-test-${RUN}-${memberCounter}@example.com`,
      membership_expires_on: '2099-01-01',
      ...overrides,
    })
    .returning('*');
  return member;
}

async function createRawSession({
  capacity = 5,
  startsAt = futureDate(24),
  durationMinutes = 60,
  primaryInstructorId = fixture.primaryInstructor.id,
  roomId = fixture.room.id,
} = {}) {
  const [session] = await db('sessions')
    .insert({
      class_id: fixture.class.id,
      primary_instructor_id: primaryInstructorId,
      room_id: roomId,
      starts_at: startsAt,
      duration_minutes: durationMinutes,
      capacity,
    })
    .returning('*');
  return session;
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

async function cancelBooking(cookie, bookingId) {
  const res = await server.request({
    method: 'POST',
    path: `/api/bookings/${bookingId}/cancel`,
    cookie,
  });
  assert.equal(res.status, 200, res.raw);
  return res.json.booking;
}

async function settleBooking(cookie, bookingId, status) {
  const res = await server.request({
    method: 'POST',
    path: `/api/bookings/${bookingId}/settle`,
    cookie,
    body: { status },
  });
  assert.equal(res.status, 200, res.raw);
  return res.json.booking;
}

function fetchCsv(cookie, sessionId) {
  return server.request({
    method: 'GET',
    path: `/api/sessions/${sessionId}/attendance.csv`,
    cookie,
  });
}

/** Parses a CSV with no quoted fields — only used against the "safe" fixture
 * where no member name contains a comma/quote/newline; the escaping-specific
 * test below checks the raw text directly instead. */
function parseSimpleCsv(text) {
  const lines = text.split('\r\n').filter((line) => line.length > 0);
  return lines.map((line) => line.split(','));
}

before(async () => {
  server = await startTestServer();

  fixture.staff = await db('users').where({ role: 'staff', is_active: true }).first();
  const instructors = await db('users')
    .where({ role: 'instructor', is_active: true })
    .select('*');
  assert.ok(instructors.length >= 3, 'seed data requires at least three active instructors');
  [fixture.primaryInstructor, fixture.coInstructor, fixture.unrelatedInstructor] = instructors;

  [fixture.room] = await db('rooms').insert({ name: `Attendance Test Room ${RUN}` }).returning('*');
  [fixture.class] = await db('classes')
    .insert({
      title: `Attendance Test Class ${RUN}`,
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

describe('GET /api/sessions/:sessionId/attendance.csv — content', () => {
  let session;
  const members = {};
  const bookings = {};

  before(async () => {
    const cookie = await loginAs(fixture.staff);
    session = await createRawSession({ capacity: 3, startsAt: futureDate(48) });

    members.a = await createMember();
    members.b = await createMember();
    members.c = await createMember();
    members.d = await createMember();
    members.e = await createMember();

    bookings.a = await bookMember(cookie, session.id, members.a.id);
    bookings.b = await bookMember(cookie, session.id, members.b.id);
    bookings.c = await bookMember(cookie, session.id, members.c.id);
    bookings.d = await bookMember(cookie, session.id, members.d.id);
    bookings.e = await bookMember(cookie, session.id, members.e.id);
    assert.equal(bookings.a.status, 'booked');
    assert.equal(bookings.b.status, 'booked');
    assert.equal(bookings.c.status, 'booked');
    assert.equal(bookings.d.status, 'waitlisted');
    assert.equal(bookings.e.status, 'waitlisted');

    // Cancelling a waitlisted booking frees no seat, so it never triggers
    // promotion — d stays waitlisted, exactly as this fixture needs.
    await cancelBooking(cookie, bookings.e.id);

    await db('sessions')
      .where({ id: session.id })
      .update({ starts_at: new Date(Date.now() - 24 * 3_600_000) });

    await settleBooking(cookie, bookings.a.id, 'attended');
    await settleBooking(cookie, bookings.b.id, 'no_show');
    // bookings.c is deliberately left unsettled, so it stays 'booked'.
  });

  it('returns a CSV with the correct header, content type and every one of the five final statuses', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await fetchCsv(cookie, session.id);
    assert.equal(res.status, 200, res.raw);
    assert.match(res.headers['content-type'], /^text\/csv/);
    assert.match(res.headers['content-disposition'], /^attachment; filename="attendance-session-.+\.csv"$/);

    const rows = parseSimpleCsv(res.raw);
    assert.deepEqual(rows[0], ['Booking ID', 'Member Name', 'Member Email', 'Status', 'Booked At']);

    const dataRows = rows.slice(1);
    assert.equal(dataRows.length, 5, res.raw);

    const byEmail = Object.fromEntries(dataRows.map((row) => [row[2], row]));
    assert.equal(byEmail[members.a.email][3], 'attended');
    assert.equal(byEmail[members.b.email][3], 'no_show');
    assert.equal(byEmail[members.c.email][3], 'booked');
    assert.equal(byEmail[members.d.email][3], 'waitlisted');
    assert.equal(byEmail[members.e.email][3], 'cancelled');
    assert.equal(byEmail[members.a.email][1], members.a.full_name);

    // Regression: `created_at` arrives from `pg` as a JS `Date`; naively
    // stringifying it renders in the server process's own local timezone
    // (e.g. "Wed Sep 02 2026 09:55:21 GMT+0530 (India Standard Time)")
    // rather than a stable instant. Every "Booked At" cell must be a real
    // ISO 8601 UTC timestamp instead.
    for (const row of dataRows) {
      assert.match(row[4], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, row[4]);
    }

    const statuses = new Set(dataRows.map((row) => row[3]));
    assert.deepEqual(
      [...statuses].sort(),
      ['attended', 'booked', 'cancelled', 'no_show', 'waitlisted'].sort(),
    );
  });

  it('reads the authoritative bookings.status column rather than replaying booking_events', async () => {
    // Bypasses the application entirely to desynchronize status from the
    // events history on purpose: the only event on this booking says
    // "created -> booked", so an implementation that replayed events instead
    // of reading `bookings.status` directly would report "booked" here, not
    // the manually-set status below.
    await db('bookings').where({ id: bookings.c.id }).update({ status: 'no_show' });
    try {
      const cookie = await loginAs(fixture.staff);
      const res = await fetchCsv(cookie, session.id);
      assert.equal(res.status, 200, res.raw);
      const rows = parseSimpleCsv(res.raw).slice(1);
      const row = rows.find((r) => r[2] === members.c.email);
      assert.equal(row[3], 'no_show');
    } finally {
      await db('bookings').where({ id: bookings.c.id }).update({ status: 'booked' });
    }
  });

  it('does not create or update any booking or booking_events row', async () => {
    const cookie = await loginAs(fixture.staff);
    const beforeBookings = await db('bookings').where({ session_id: session.id }).select('*');
    const beforeEvents = await db('booking_events')
      .whereIn('booking_id', beforeBookings.map((b) => b.id))
      .select('*');

    await fetchCsv(cookie, session.id);
    await fetchCsv(cookie, session.id);

    const afterBookings = await db('bookings').where({ session_id: session.id }).select('*');
    const afterEvents = await db('booking_events')
      .whereIn('booking_id', afterBookings.map((b) => b.id))
      .select('*');

    assert.equal(afterBookings.length, beforeBookings.length);
    assert.equal(afterEvents.length, beforeEvents.length);
    assert.deepEqual(
      afterBookings.map((b) => ({ id: b.id, status: b.status, updated_at: b.updated_at.getTime() })),
      beforeBookings.map((b) => ({ id: b.id, status: b.status, updated_at: b.updated_at.getTime() })),
    );
  });
});

describe('GET /api/sessions/:sessionId/attendance.csv — CSV escaping', () => {
  it('escapes commas, quotes, and embedded newlines in a member name', async () => {
    const cookie = await loginAs(fixture.staff);
    const session = await createRawSession({ capacity: 5, startsAt: futureDate(72) });
    const member = await createMember({ full_name: 'Doe, Jane "JJ"\nSecond Line' });
    await bookMember(cookie, session.id, member.id);

    const res = await fetchCsv(cookie, session.id);
    assert.equal(res.status, 200, res.raw);

    // RFC 4180: wrap in quotes, double the embedded quotes, keep the comma
    // and newline literally inside the quoted field.
    const expectedField = '"Doe, Jane ""JJ""\nSecond Line"';
    assert.ok(
      res.raw.includes(expectedField),
      `expected the escaped field ${JSON.stringify(expectedField)} in:\n${res.raw}`,
    );
  });

  it('neutralizes a member name that looks like a spreadsheet formula (CSV/formula injection)', async () => {
    const cookie = await loginAs(fixture.staff);
    const session = await createRawSession({ capacity: 5, startsAt: futureDate(73) });
    const member = await createMember({ full_name: "=cmd|'/ccalc'!A1" });
    await bookMember(cookie, session.id, member.id);

    const res = await fetchCsv(cookie, session.id);
    assert.equal(res.status, 200, res.raw);

    // A leading apostrophe is what makes every spreadsheet application treat
    // the cell as literal text instead of offering to evaluate it as a
    // formula when the export is opened — the raw name must never appear
    // with `=` still in the leading position.
    assert.ok(
      res.raw.includes("'=cmd|'/ccalc'!A1"),
      `expected the formula-neutralized field in:\n${res.raw}`,
    );
    assert.doesNotMatch(res.raw, /(?:^|,)=cmd/m);
  });
});

describe('GET /api/sessions/:sessionId/attendance.csv — authorization', () => {
  let session;

  before(async () => {
    session = await createRawSession({ capacity: 5, startsAt: futureDate(96) });
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'POST',
      path: `/api/sessions/${session.id}/co-instructors`,
      cookie,
      body: { instructorId: fixture.coInstructor.id },
    });
    assert.equal(res.status, 201, res.raw);
  });

  it('lets staff export', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await fetchCsv(cookie, session.id);
    assert.equal(res.status, 200, res.raw);
  });

  it('lets the primary instructor export', async () => {
    const cookie = await loginAs(fixture.primaryInstructor);
    const res = await fetchCsv(cookie, session.id);
    assert.equal(res.status, 200, res.raw);
  });

  it('lets a co-instructor export', async () => {
    const cookie = await loginAs(fixture.coInstructor);
    const res = await fetchCsv(cookie, session.id);
    assert.equal(res.status, 200, res.raw);
  });

  it('denies an unrelated instructor — session ID tampering into someone else\'s session', async () => {
    const cookie = await loginAs(fixture.unrelatedInstructor);
    const res = await fetchCsv(cookie, session.id);
    assert.equal(res.status, 403, res.raw);
  });

  it('denies an unauthenticated request', async () => {
    const res = await server.request({
      method: 'GET',
      path: `/api/sessions/${session.id}/attendance.csv`,
    });
    assert.equal(res.status, 401);
  });

  it('revokes co-instructor export access immediately when the assignment is removed', async () => {
    const raceSession = await createRawSession({ capacity: 5, startsAt: futureDate(120) });
    const staffCookie = await loginAs(fixture.staff);
    const addRes = await server.request({
      method: 'POST',
      path: `/api/sessions/${raceSession.id}/co-instructors`,
      cookie: staffCookie,
      body: { instructorId: fixture.unrelatedInstructor.id },
    });
    assert.equal(addRes.status, 201, addRes.raw);

    const cookie = await loginAs(fixture.unrelatedInstructor);
    const whileCoInstructor = await fetchCsv(cookie, raceSession.id);
    assert.equal(whileCoInstructor.status, 200, whileCoInstructor.raw);

    const removeRes = await server.request({
      method: 'DELETE',
      path: `/api/sessions/${raceSession.id}/co-instructors/${fixture.unrelatedInstructor.id}`,
      cookie: staffCookie,
    });
    assert.equal(removeRes.status, 204);

    const afterRemoval = await fetchCsv(cookie, raceSession.id);
    assert.equal(afterRemoval.status, 403);
  });
});
