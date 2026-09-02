import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Goal 8 — `GET /api/dashboard`, exercised over real HTTP against a running
 * app and a live database.
 *
 * Every metric this endpoint reports is a studio-*wide* aggregate — unlike
 * every other collection endpoint in this codebase, there is no session/
 * class/room id to scope a fixture to. Every earlier test file that creates
 * a real booking leaves its sessions/bookings in the database permanently
 * (`ON DELETE RESTRICT` plus append-only `booking_events` — see
 * `bookings.test.js`'s own comment), and by the time this file runs there
 * are already hundreds of leftover rows from every other suite scattered
 * across "today", "this week" and the last eight weeks. Asserting an
 * absolute count (`sessionsToday === 3`) would therefore be asserting
 * against however much of that leftover data happens to land in the
 * relevant window on this particular run — exactly the "small relative-date
 * window colliding with previous-run data" failure mode raised for this
 * milestone.
 *
 * Every correctness test below is therefore delta-based: fetch the
 * dashboard, insert one precisely-controlled fixture row (a raw DB insert,
 * not the conflict-checked APIs — nothing here exercises booking/session
 * business rules, only the dashboard's own aggregation), fetch the
 * dashboard again, and assert the metric moved by exactly the expected
 * amount. That is correct regardless of what any other suite has already
 * left behind, and remains correct however many times this file itself is
 * re-run.
 */

let server;
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

async function fetchDashboard(cookie) {
  const res = await server.request({ method: 'GET', path: '/api/dashboard', cookie });
  assert.equal(res.status, 200, res.raw);
  return res.json;
}

/** The exact instant PostgreSQL's `AT TIME ZONE` resolves a local date/time
 * to — used only to build fixtures at precise studio-local boundaries, the
 * same technique `recurringSessions.test.js#resolveInstant` already uses. */
async function resolveInstant(localTimestampStr) {
  const { rows } = await db.raw('SELECT (?::timestamp AT TIME ZONE ?) AS instant', [
    localTimestampStr,
    env.STUDIO_TIMEZONE,
  ]);
  return rows[0].instant;
}

/** Studio-local "today" (`YYYY-MM-DD`) and the Monday (`YYYY-MM-DD`) of the
 * studio-local week containing "now" — the same `date_trunc('week', ...)`
 * Postgres itself uses, so these are ground truth for the boundary tests,
 * not a re-derivation of the endpoint's own logic. */
async function studioTodayAndWeekStart() {
  const { rows } = await db.raw(
    `SELECT (now() AT TIME ZONE ?)::date AS today,
            date_trunc('week', now() AT TIME ZONE ?)::date AS week_start`,
    [env.STUDIO_TIMEZONE, env.STUDIO_TIMEZONE],
  );
  return { today: rows[0].today, weekStart: rows[0].week_start };
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

async function createMember() {
  memberCounter += 1;
  const [member] = await db('members')
    .insert({
      full_name: `Dashboard Test Member ${Date.now()}-${memberCounter}`,
      email: `dashboard-test-${Date.now()}-${memberCounter}@example.com`,
      membership_expires_on: '2099-01-01',
    })
    .returning('*');
  return member;
}

/** A raw session insert, bypassing the conflict-checked `POST
 * /api/sessions` entirely: nothing here tests scheduling rules, only the
 * dashboard's own time-window math, so an arbitrary `startsAt` (including
 * one in the past) with no conflict checking at all is exactly what these
 * fixtures need. */
async function createRawSession({ startsAt, roomId = fixture.room.id, capacity = 5 } = {}) {
  const [session] = await db('sessions')
    .insert({
      class_id: fixture.class.id,
      primary_instructor_id: fixture.instructor.id,
      room_id: roomId,
      starts_at: startsAt,
      duration_minutes: 60,
      capacity,
    })
    .returning('*');
  return session;
}

/**
 * A raw booking insert with a schema-valid `booking_events` trail, bypassing
 * every booking-lifecycle timing/transition rule on purpose — this file
 * tests dashboard aggregation, not the state machine those rules already
 * have their own exhaustive suite for (`bookings.test.js`,
 * `bookingConcurrency.test.js`). `finalStatus` can be any of the five
 * statuses regardless of the session's own `starts_at`, which the real
 * settle/cancel endpoints would never allow.
 */
async function insertBookingWithHistory({ sessionId, memberId, finalStatus, createdAt = new Date() }) {
  const initialStatus = finalStatus === 'waitlisted' ? 'waitlisted' : 'booked';
  const [booking] = await db('bookings')
    .insert({
      session_id: sessionId,
      member_id: memberId,
      status: initialStatus,
      created_at: createdAt,
      updated_at: createdAt,
    })
    .returning('*');
  await db('booking_events').insert({
    booking_id: booking.id,
    event_type: 'created',
    to_status: initialStatus,
    actor_user_id: fixture.staff.id,
    occurred_at: createdAt,
  });
  if (finalStatus !== initialStatus) {
    await db('bookings')
      .where({ id: booking.id })
      .update({ status: finalStatus, updated_at: createdAt });
    await db('booking_events').insert({
      booking_id: booking.id,
      event_type: 'status_changed',
      from_status: initialStatus,
      to_status: finalStatus,
      actor_user_id: fixture.staff.id,
      occurred_at: createdAt,
    });
  }
  return { ...booking, status: finalStatus };
}

async function cancelBookingDirectly(bookingId, fromStatus) {
  await db('bookings').where({ id: bookingId }).update({ status: 'cancelled', updated_at: new Date() });
  await db('booking_events').insert({
    booking_id: bookingId,
    event_type: 'status_changed',
    from_status: fromStatus,
    to_status: 'cancelled',
    actor_user_id: fixture.staff.id,
  });
}

before(async () => {
  server = await startTestServer();

  fixture.staff = await db('users').where({ role: 'staff', is_active: true }).first();
  fixture.instructor = await db('users').where({ role: 'instructor', is_active: true }).first();

  [fixture.room] = await db('rooms').insert({ name: `Dashboard Test Room ${Date.now()}` }).returning('*');
  [fixture.class] = await db('classes')
    .insert({
      title: `Dashboard Test Class ${Date.now()}`,
      discipline: 'Testing',
      default_duration_minutes: 60,
      default_capacity: 5,
    })
    .returning('*');

  // A shared, far-future session with no bookings — a stable target for
  // fixtures that only need *some* valid session (the members-waitlisted,
  // bookings-today and bookings-by-status tests don't care when it runs).
  fixture.session = await createRawSession({ startsAt: new Date(Date.now() + 400 * 86_400_000) });
});

after(async () => {
  await server.stop();
  await closeConnection();
});

describe('GET /api/dashboard — authorization', () => {
  it('lets staff access the dashboard', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({ method: 'GET', path: '/api/dashboard', cookie });
    assert.equal(res.status, 200, res.raw);
  });

  it('denies an instructor', async () => {
    const cookie = await loginAs(fixture.instructor);
    const res = await server.request({ method: 'GET', path: '/api/dashboard', cookie });
    assert.equal(res.status, 403);
  });

  it('denies an unauthenticated request', async () => {
    const res = await server.request({ method: 'GET', path: '/api/dashboard' });
    assert.equal(res.status, 401);
  });

  it('cannot be bypassed by an instructor spoofing a staff role via query parameter', async () => {
    const cookie = await loginAs(fixture.instructor);
    const res = await server.request({ method: 'GET', path: '/api/dashboard?role=staff', cookie });
    assert.equal(res.status, 403);
  });
});

describe('GET /api/dashboard — response shape', () => {
  it('always returns every field, numeric and non-null, with the fixed status/week shapes', async () => {
    const cookie = await loginAs(fixture.staff);
    const dashboard = await fetchDashboard(cookie);

    assert.equal(typeof dashboard.headline.sessionsToday, 'number');
    assert.equal(typeof dashboard.headline.bookingsToday, 'number');
    assert.equal(typeof dashboard.headline.noShowsThisWeek, 'number');
    assert.equal(typeof dashboard.headline.membersWaitlisted, 'number');
    assert.ok(dashboard.headline.sessionsToday >= 0);
    assert.ok(dashboard.headline.bookingsToday >= 0);
    assert.ok(dashboard.headline.noShowsThisWeek >= 0);
    assert.ok(dashboard.headline.membersWaitlisted >= 0);

    assert.deepEqual(
      Object.keys(dashboard.bookingsByStatus).sort(),
      ['attended', 'booked', 'cancelled', 'no_show', 'waitlisted'].sort(),
    );
    for (const count of Object.values(dashboard.bookingsByStatus)) {
      assert.equal(typeof count, 'number');
      assert.ok(count >= 0);
    }

    assert.ok(Array.isArray(dashboard.bookingsByClass));
    for (const row of dashboard.bookingsByClass) {
      assert.equal(typeof row.classId, 'string');
      assert.equal(typeof row.classTitle, 'string');
      assert.equal(typeof row.count, 'number');
      assert.ok(row.count >= 1, 'a class with zero bookings must not appear at all');
    }

    assert.equal(dashboard.attendancePerWeek.length, 8);
    for (const week of dashboard.attendancePerWeek) {
      assert.match(week.weekStart, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(typeof week.count, 'number');
      assert.ok(week.count >= 0);
    }
    for (let i = 1; i < dashboard.attendancePerWeek.length; i += 1) {
      const prev = new Date(`${dashboard.attendancePerWeek[i - 1].weekStart}T00:00:00Z`);
      const curr = new Date(`${dashboard.attendancePerWeek[i].weekStart}T00:00:00Z`);
      assert.equal(curr.getTime() - prev.getTime(), 7 * 86_400_000, 'week buckets must be exactly 7 days apart');
    }

    const { weekStart } = await studioTodayAndWeekStart();
    assert.equal(
      dashboard.attendancePerWeek[dashboard.attendancePerWeek.length - 1].weekStart,
      weekStart,
      'the last bucket must be the current studio-local week',
    );
  });
});

describe('GET /api/dashboard — sessions today', () => {
  it('counts a session starting today', async () => {
    const { today } = await studioTodayAndWeekStart();
    const before = await fetchDashboard(await loginAs(fixture.staff));
    await createRawSession({ startsAt: await resolveInstant(`${today} 12:00`) });
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.sessionsToday, before.headline.sessionsToday + 1);
  });

  it('counts a session starting exactly at the start of today (inclusive boundary)', async () => {
    const { today } = await studioTodayAndWeekStart();
    const before = await fetchDashboard(await loginAs(fixture.staff));
    await createRawSession({ startsAt: await resolveInstant(`${today} 00:00`) });
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.sessionsToday, before.headline.sessionsToday + 1);
  });

  it('does not count a session ending the instant before today starts', async () => {
    const { today } = await studioTodayAndWeekStart();
    const todayStart = await resolveInstant(`${today} 00:00`);
    const before = await fetchDashboard(await loginAs(fixture.staff));
    await createRawSession({ startsAt: new Date(new Date(todayStart).getTime() - 1000) });
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.sessionsToday, before.headline.sessionsToday);
  });

  it('does not count a session starting exactly at the start of tomorrow (exclusive boundary)', async () => {
    const { today } = await studioTodayAndWeekStart();
    const before = await fetchDashboard(await loginAs(fixture.staff));
    await createRawSession({ startsAt: await resolveInstant(`${addDays(today, 1)} 00:00`) });
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.sessionsToday, before.headline.sessionsToday);
  });
});

describe('GET /api/dashboard — bookings made today', () => {
  it('counts a booking created today, keyed by creation time regardless of current status', async () => {
    const { today } = await studioTodayAndWeekStart();
    const createdAt = await resolveInstant(`${today} 12:00`);
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const member = await createMember();
    // Cancelled the same day it was created — "made today" still counts it:
    // this metric is about creation, not the booking's current status.
    await insertBookingWithHistory({
      sessionId: fixture.session.id,
      memberId: member.id,
      finalStatus: 'cancelled',
      createdAt,
    });
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.bookingsToday, before.headline.bookingsToday + 1);
  });

  it('counts a booking created exactly at the start of today (inclusive boundary)', async () => {
    const { today } = await studioTodayAndWeekStart();
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const member = await createMember();
    await insertBookingWithHistory({
      sessionId: fixture.session.id,
      memberId: member.id,
      finalStatus: 'booked',
      createdAt: await resolveInstant(`${today} 00:00`),
    });
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.bookingsToday, before.headline.bookingsToday + 1);
  });

  it('does not count a booking created the instant before today starts', async () => {
    const { today } = await studioTodayAndWeekStart();
    const todayStart = await resolveInstant(`${today} 00:00`);
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const member = await createMember();
    await insertBookingWithHistory({
      sessionId: fixture.session.id,
      memberId: member.id,
      finalStatus: 'booked',
      createdAt: new Date(new Date(todayStart).getTime() - 1000),
    });
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.bookingsToday, before.headline.bookingsToday);
  });
});

describe('GET /api/dashboard — no-shows this week', () => {
  it('counts a no_show booking whose session starts this week, keyed by the session — not the booking\'s creation time', async () => {
    const { weekStart } = await studioTodayAndWeekStart();
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const session = await createRawSession({ startsAt: await resolveInstant(`${weekStart} 09:00`) });
    const member = await createMember();
    // Created weeks before the session it's for — proves the count is keyed
    // by sessions.starts_at, not bookings.created_at.
    await insertBookingWithHistory({
      sessionId: session.id,
      memberId: member.id,
      finalStatus: 'no_show',
      createdAt: await resolveInstant(`${addDays(weekStart, -70)} 09:00`),
    });
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.noShowsThisWeek, before.headline.noShowsThisWeek + 1);
  });

  it('counts a no_show whose session starts exactly at the start of this week (inclusive boundary)', async () => {
    const { weekStart } = await studioTodayAndWeekStart();
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const session = await createRawSession({ startsAt: await resolveInstant(`${weekStart} 00:00`) });
    const member = await createMember();
    await insertBookingWithHistory({ sessionId: session.id, memberId: member.id, finalStatus: 'no_show' });
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.noShowsThisWeek, before.headline.noShowsThisWeek + 1);
  });

  it('does not count a no_show whose session ends the instant before this week starts', async () => {
    const { weekStart } = await studioTodayAndWeekStart();
    const weekStartInstant = await resolveInstant(`${weekStart} 00:00`);
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const session = await createRawSession({ startsAt: new Date(new Date(weekStartInstant).getTime() - 1000) });
    const member = await createMember();
    await insertBookingWithHistory({ sessionId: session.id, memberId: member.id, finalStatus: 'no_show' });
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.noShowsThisWeek, before.headline.noShowsThisWeek);
  });

  it('does not count a no_show whose session starts exactly at the start of next week', async () => {
    const { weekStart } = await studioTodayAndWeekStart();
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const session = await createRawSession({ startsAt: await resolveInstant(`${addDays(weekStart, 7)} 00:00`) });
    const member = await createMember();
    await insertBookingWithHistory({ sessionId: session.id, memberId: member.id, finalStatus: 'no_show' });
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.noShowsThisWeek, before.headline.noShowsThisWeek);
  });

  it('does not count a booked/attended/cancelled/waitlisted booking for a session this week', async () => {
    const { weekStart } = await studioTodayAndWeekStart();
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const session = await createRawSession({ startsAt: await resolveInstant(`${weekStart} 10:00`) });
    for (const finalStatus of ['booked', 'attended', 'cancelled', 'waitlisted']) {
      const member = await createMember();
      await insertBookingWithHistory({ sessionId: session.id, memberId: member.id, finalStatus });
    }
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.noShowsThisWeek, before.headline.noShowsThisWeek);
  });
});

describe('GET /api/dashboard — members currently waitlisted', () => {
  it('counts a distinct member, not a distinct booking: two waitlisted bookings for the same member count once', async () => {
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const member = await createMember();
    const sessionA = await createRawSession({ startsAt: new Date(Date.now() + 401 * 86_400_000) });
    const sessionB = await createRawSession({ startsAt: new Date(Date.now() + 402 * 86_400_000) });
    await insertBookingWithHistory({ sessionId: sessionA.id, memberId: member.id, finalStatus: 'waitlisted' });
    const afterFirst = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(afterFirst.headline.membersWaitlisted, before.headline.membersWaitlisted + 1);

    await insertBookingWithHistory({ sessionId: sessionB.id, memberId: member.id, finalStatus: 'waitlisted' });
    const afterSecond = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(
      afterSecond.headline.membersWaitlisted,
      afterFirst.headline.membersWaitlisted,
      'the same member waitlisted twice must still only count once',
    );
  });

  it('stops counting a member once their waitlisted booking is cancelled', async () => {
    const member = await createMember();
    const booking = await insertBookingWithHistory({
      sessionId: fixture.session.id,
      memberId: member.id,
      finalStatus: 'waitlisted',
    });
    const before = await fetchDashboard(await loginAs(fixture.staff));
    await cancelBookingDirectly(booking.id, 'waitlisted');
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.membersWaitlisted, before.headline.membersWaitlisted - 1);
  });

  it('does not count a booked (not waitlisted) booking', async () => {
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const member = await createMember();
    await insertBookingWithHistory({ sessionId: fixture.session.id, memberId: member.id, finalStatus: 'booked' });
    const after = await fetchDashboard(await loginAs(fixture.staff));
    assert.equal(after.headline.membersWaitlisted, before.headline.membersWaitlisted);
  });
});

describe('GET /api/dashboard — bookings by status', () => {
  it('increments exactly the created status, for each of the five statuses', async () => {
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const statuses = ['booked', 'waitlisted', 'cancelled', 'attended', 'no_show'];
    for (const status of statuses) {
      const member = await createMember();
      await insertBookingWithHistory({ sessionId: fixture.session.id, memberId: member.id, finalStatus: status });
    }
    const after = await fetchDashboard(await loginAs(fixture.staff));
    for (const status of statuses) {
      assert.equal(
        after.bookingsByStatus[status],
        before.bookingsByStatus[status] + 1,
        `status ${status} must increase by exactly 1`,
      );
    }
  });
});

describe('GET /api/dashboard — bookings by class', () => {
  it('shows a newly booked class and omits a class with no bookings at all', async () => {
    const [emptyClass] = await db('classes')
      .insert({
        title: `Dashboard Empty Class ${Date.now()}`,
        discipline: 'Testing',
        default_duration_minutes: 60,
        default_capacity: 5,
      })
      .returning('*');
    const [bookedClass] = await db('classes')
      .insert({
        title: `Dashboard Booked Class ${Date.now()}`,
        discipline: 'Testing',
        default_duration_minutes: 60,
        default_capacity: 5,
      })
      .returning('*');
    const [session] = await db('sessions')
      .insert({
        class_id: bookedClass.id,
        primary_instructor_id: fixture.instructor.id,
        room_id: fixture.room.id,
        starts_at: new Date(Date.now() + 403 * 86_400_000),
        duration_minutes: 60,
        capacity: 5,
      })
      .returning('*');
    const member = await createMember();
    await insertBookingWithHistory({ sessionId: session.id, memberId: member.id, finalStatus: 'booked' });

    const dashboard = await fetchDashboard(await loginAs(fixture.staff));
    const bookedRow = dashboard.bookingsByClass.find((row) => row.classId === String(bookedClass.id));
    assert.ok(bookedRow, 'a class with a booking must appear in the breakdown');
    assert.equal(bookedRow.count, 1);
    assert.equal(bookedRow.classTitle, bookedClass.title);

    const emptyRow = dashboard.bookingsByClass.find((row) => row.classId === String(emptyClass.id));
    assert.equal(emptyRow, undefined, 'a class with zero bookings must not appear');
  });
});

describe('GET /api/dashboard — attendance per week', () => {
  it('counts an attended booking in the current week\'s bucket', async () => {
    const { weekStart } = await studioTodayAndWeekStart();
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const session = await createRawSession({ startsAt: await resolveInstant(`${weekStart} 09:00`) });
    const member = await createMember();
    await insertBookingWithHistory({ sessionId: session.id, memberId: member.id, finalStatus: 'attended' });
    const after = await fetchDashboard(await loginAs(fixture.staff));

    const beforeWeek = before.attendancePerWeek.find((w) => w.weekStart === weekStart);
    const afterWeek = after.attendancePerWeek.find((w) => w.weekStart === weekStart);
    assert.equal(afterWeek.count, beforeWeek.count + 1);
  });

  it('counts an attended booking in the oldest (7-weeks-ago) in-window bucket', async () => {
    const { weekStart } = await studioTodayAndWeekStart();
    const oldestWeek = addDays(weekStart, -49); // 7 weeks before this week
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const session = await createRawSession({ startsAt: await resolveInstant(`${oldestWeek} 09:00`) });
    const member = await createMember();
    await insertBookingWithHistory({ sessionId: session.id, memberId: member.id, finalStatus: 'attended' });
    const after = await fetchDashboard(await loginAs(fixture.staff));

    const beforeWeek = before.attendancePerWeek.find((w) => w.weekStart === oldestWeek);
    const afterWeek = after.attendancePerWeek.find((w) => w.weekStart === oldestWeek);
    assert.ok(beforeWeek, 'the 7-weeks-ago bucket must be present in the fixed 8-week window');
    assert.equal(afterWeek.count, beforeWeek.count + 1);
  });

  it('does not count an attended booking 8 weeks ago — just outside the window', async () => {
    const { weekStart } = await studioTodayAndWeekStart();
    const justOutsideWeek = addDays(weekStart, -56); // 8 weeks before this week
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const session = await createRawSession({ startsAt: await resolveInstant(`${justOutsideWeek} 09:00`) });
    const member = await createMember();
    await insertBookingWithHistory({ sessionId: session.id, memberId: member.id, finalStatus: 'attended' });
    const after = await fetchDashboard(await loginAs(fixture.staff));

    assert.equal(
      after.attendancePerWeek.some((w) => w.weekStart === justOutsideWeek),
      false,
      'a week 8 weeks ago must not appear in the 8-week window at all',
    );
    assert.deepEqual(after.attendancePerWeek, before.attendancePerWeek);
  });

  it('does not count a non-attended booking for a session in an in-window week', async () => {
    const { weekStart } = await studioTodayAndWeekStart();
    const before = await fetchDashboard(await loginAs(fixture.staff));
    const session = await createRawSession({ startsAt: await resolveInstant(`${weekStart} 11:00`) });
    const member = await createMember();
    await insertBookingWithHistory({ sessionId: session.id, memberId: member.id, finalStatus: 'no_show' });
    const after = await fetchDashboard(await loginAs(fixture.staff));

    const beforeWeek = before.attendancePerWeek.find((w) => w.weekStart === weekStart);
    const afterWeek = after.attendancePerWeek.find((w) => w.weekStart === weekStart);
    assert.equal(afterWeek.count, beforeWeek.count);
  });
});
