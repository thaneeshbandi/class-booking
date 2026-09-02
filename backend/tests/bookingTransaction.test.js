import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import {
  countOccupiedSeats,
  countSettledBookings,
  loadBookingForUpdate,
  lockSessionForBooking,
  promoteWaitlistFIFO,
  translateBookingPgError,
  writeBookingEvent,
} from '../src/domain/bookingTransaction.js';
import { BookingError } from '../src/domain/bookingErrors.js';

/**
 * Phase P2 — the reusable booking-transaction primitives, exercised directly
 * against a live database with no HTTP layer and no routes (none exist yet).
 *
 * Every fixture here is uniquely named per run (`RUN`) and, once a booking is
 * attached to it, deliberately never cleaned up: `bookings.session_id` /
 * `member_id` are `ON DELETE RESTRICT` and `booking_events` is append-only,
 * so a session or member with real booking history is permanently
 * undeletable by design (see `sessions.test.js`'s "Undeletable Session
 * Fixture"). Uniqueness, not deletion, is what keeps repeated runs clean.
 */

const RUN = Date.now();
const fixture = {};

function futureDate(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3_600_000);
}

async function insertSession({ startsAt, durationMinutes = 60, capacity = 5 }) {
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

async function insertMember(suffix) {
  const [member] = await db('members')
    .insert({
      full_name: `Booking Transaction Test Member ${suffix}`,
      email: `booking-txn-test-${RUN}-${suffix}@example.com`,
      membership_expires_on: '2099-01-01',
    })
    .returning('*');
  return member;
}

async function insertBooking({ sessionId, memberId, status, createdAt }) {
  const [booking] = await db('bookings')
    .insert({
      session_id: sessionId,
      member_id: memberId,
      status,
      created_at: createdAt ?? db.fn.now(),
    })
    .returning('*');
  return booking;
}

before(async () => {
  fixture.staff = await db('users').where({ role: 'staff', is_active: true }).first();
  fixture.instructor = await db('users')
    .where({ role: 'instructor', is_active: true })
    .first();
  assert.ok(fixture.staff, 'seed data requires an active staff account');
  assert.ok(fixture.instructor, 'seed data requires an active instructor account');

  [fixture.room] = await db('rooms')
    .insert({ name: `Booking Transaction Test Room ${RUN}` })
    .returning('*');
  [fixture.class] = await db('classes')
    .insert({
      title: `Booking Transaction Test Class ${RUN}`,
      discipline: 'Testing',
      default_duration_minutes: 60,
      default_capacity: 5,
    })
    .returning('*');
});

after(async () => {
  await closeConnection();
});

describe('lockSessionForBooking', () => {
  it('returns undefined for a session that does not exist', async () => {
    await db.transaction(async (trx) => {
      const result = await lockSessionForBooking(trx, 999999999);
      assert.equal(result, undefined);
    });
  });

  it('reports hasStarted=false and hasFinished=false for a future session', async () => {
    const session = await insertSession({ startsAt: futureDate(48), durationMinutes: 60, capacity: 3 });
    await db.transaction(async (trx) => {
      const locked = await lockSessionForBooking(trx, session.id);
      assert.equal(String(locked.id), String(session.id));
      assert.equal(locked.capacity, 3);
      assert.equal(locked.hasStarted, false);
      assert.equal(locked.hasFinished, false);
    });
  });

  it('reports hasStarted=true and hasFinished=true for a session well in the past', async () => {
    const session = await insertSession({
      startsAt: futureDate(-2), // 2 hours ago
      durationMinutes: 30,
      capacity: 3,
    });
    await db.transaction(async (trx) => {
      const locked = await lockSessionForBooking(trx, session.id);
      assert.equal(locked.hasStarted, true);
      assert.equal(locked.hasFinished, true);
    });
  });

  it('reports hasStarted=true and hasFinished=false for a session currently running', async () => {
    const session = await insertSession({
      startsAt: futureDate(-0.25), // 15 minutes ago
      durationMinutes: 60,
      capacity: 3,
    });
    await db.transaction(async (trx) => {
      const locked = await lockSessionForBooking(trx, session.id);
      assert.equal(locked.hasStarted, true);
      assert.equal(locked.hasFinished, false);
    });
  });

  it('computes studioToday identically to a direct AT TIME ZONE query', async () => {
    const session = await insertSession({ startsAt: futureDate(100), capacity: 3 });
    const { rows } = await db.raw(
      `SELECT to_char((now() AT TIME ZONE ?), 'YYYY-MM-DD') AS today`,
      [env.STUDIO_TIMEZONE],
    );
    await db.transaction(async (trx) => {
      const locked = await lockSessionForBooking(trx, session.id);
      assert.equal(locked.studioToday, rows[0].today);
      assert.match(locked.studioToday, /^\d{4}-\d{2}-\d{2}$/);
    });
  });
});

describe('countOccupiedSeats / countSettledBookings', () => {
  it('counts booked, attended and no_show as occupied; never waitlisted or cancelled', async () => {
    const session = await insertSession({ startsAt: futureDate(200), capacity: 10 });
    const members = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((s) => insertMember(`occ-${s}-${RUN}`)),
    );
    await insertBooking({ sessionId: session.id, memberId: members[0].id, status: 'booked' });
    await insertBooking({ sessionId: session.id, memberId: members[1].id, status: 'attended' });
    await insertBooking({ sessionId: session.id, memberId: members[2].id, status: 'no_show' });
    await insertBooking({ sessionId: session.id, memberId: members[3].id, status: 'waitlisted' });
    await insertBooking({ sessionId: session.id, memberId: members[4].id, status: 'cancelled' });

    await db.transaction(async (trx) => {
      assert.equal(await countOccupiedSeats(trx, session.id), 3);
      assert.equal(await countSettledBookings(trx, session.id), 2);
    });
  });

  it('returns zero for a session with no bookings', async () => {
    const session = await insertSession({ startsAt: futureDate(201), capacity: 10 });
    await db.transaction(async (trx) => {
      assert.equal(await countOccupiedSeats(trx, session.id), 0);
      assert.equal(await countSettledBookings(trx, session.id), 0);
    });
  });
});

describe('loadBookingForUpdate', () => {
  it('loads the booking row', async () => {
    const session = await insertSession({ startsAt: futureDate(202), capacity: 5 });
    const member = await insertMember(`lbfu-${RUN}`);
    const booking = await insertBooking({ sessionId: session.id, memberId: member.id, status: 'booked' });

    await db.transaction(async (trx) => {
      const loaded = await loadBookingForUpdate(trx, booking.id);
      assert.equal(String(loaded.id), String(booking.id));
      assert.equal(loaded.status, 'booked');
    });
  });
});

describe('writeBookingEvent', () => {
  it('writes a created event', async () => {
    const session = await insertSession({ startsAt: futureDate(203), capacity: 5 });
    const member = await insertMember(`wbe-created-${RUN}`);
    const booking = await insertBooking({ sessionId: session.id, memberId: member.id, status: 'booked' });

    await db.transaction(async (trx) => {
      await writeBookingEvent(trx, {
        bookingId: booking.id,
        eventType: 'created',
        toStatus: 'booked',
        actorUserId: fixture.staff.id,
      });
    });

    const event = await db('booking_events').where({ booking_id: booking.id }).first();
    assert.equal(event.event_type, 'created');
    assert.equal(event.from_status, null);
    assert.equal(event.to_status, 'booked');
    assert.equal(String(event.actor_user_id), String(fixture.staff.id));
    assert.equal(event.is_automatic, false);
  });

  it('writes an automatic status_changed event with a caused_by_booking_id', async () => {
    const session = await insertSession({ startsAt: futureDate(204), capacity: 5 });
    const member = await insertMember(`wbe-auto-${RUN}`);
    const cancelledBy = await insertMember(`wbe-cause-${RUN}`);
    const booking = await insertBooking({ sessionId: session.id, memberId: member.id, status: 'booked' });
    const causeBooking = await insertBooking({
      sessionId: session.id,
      memberId: cancelledBy.id,
      status: 'cancelled',
    });

    await db.transaction(async (trx) => {
      await writeBookingEvent(trx, {
        bookingId: booking.id,
        eventType: 'status_changed',
        fromStatus: 'waitlisted',
        toStatus: 'booked',
        actorUserId: fixture.staff.id,
        isAutomatic: true,
        causedByBookingId: causeBooking.id,
      });
    });

    const event = await db('booking_events')
      .where({ booking_id: booking.id, event_type: 'status_changed' })
      .first();
    assert.equal(event.is_automatic, true);
    assert.equal(String(event.caused_by_booking_id), String(causeBooking.id));
  });

  it('writes a note event', async () => {
    const session = await insertSession({ startsAt: futureDate(205), capacity: 5 });
    const member = await insertMember(`wbe-note-${RUN}`);
    const booking = await insertBooking({ sessionId: session.id, memberId: member.id, status: 'booked' });

    await db.transaction(async (trx) => {
      await writeBookingEvent(trx, {
        bookingId: booking.id,
        eventType: 'note',
        note: 'Called ahead to confirm.',
        actorUserId: fixture.staff.id,
      });
    });

    const event = await db('booking_events')
      .where({ booking_id: booking.id, event_type: 'note' })
      .first();
    assert.equal(event.note, 'Called ahead to confirm.');
    assert.equal(event.from_status, null);
    assert.equal(event.to_status, null);
  });
});

describe('promoteWaitlistFIFO', () => {
  it('is a no-op when there are no free seats', async () => {
    const session = await insertSession({ startsAt: futureDate(300), capacity: 1 });
    const member = await insertMember(`fifo-noop-${RUN}`);
    await insertBooking({ sessionId: session.id, memberId: member.id, status: 'waitlisted' });

    await db.transaction(async (trx) => {
      const promoted = await promoteWaitlistFIFO(trx, {
        sessionId: session.id,
        freeSeats: 0,
        actorUserId: fixture.staff.id,
      });
      assert.deepEqual(promoted, []);
    });
  });

  it('promotes exactly the earliest N waitlisted bookings in created_at, id order', async () => {
    const session = await insertSession({ startsAt: futureDate(301), capacity: 5 });
    const members = await Promise.all(
      ['first', 'second', 'third', 'fourth'].map((s) => insertMember(`fifo-order-${s}-${RUN}`)),
    );
    const base = new Date();
    const bookings = [];
    for (const [i, member] of members.entries()) {
      bookings.push(
        await insertBooking({
          sessionId: session.id,
          memberId: member.id,
          status: 'waitlisted',
          createdAt: new Date(base.getTime() + i * 1000),
        }),
      );
    }

    let promoted;
    await db.transaction(async (trx) => {
      promoted = await promoteWaitlistFIFO(trx, {
        sessionId: session.id,
        freeSeats: 2,
        actorUserId: fixture.staff.id,
        causedByBookingId: null,
      });
    });

    assert.equal(promoted.length, 2);
    assert.deepEqual(
      promoted.map((b) => String(b.id)),
      [String(bookings[0].id), String(bookings[1].id)],
      'the two earliest-created waitlisted bookings must be promoted, in order',
    );
    assert.ok(promoted.every((b) => b.status === 'booked'));

    const stillWaitlisted = await db('bookings')
      .whereIn('id', [bookings[2].id, bookings[3].id])
      .select('status');
    assert.ok(stillWaitlisted.every((b) => b.status === 'waitlisted'));

    const events = await db('booking_events')
      .whereIn('booking_id', [bookings[0].id, bookings[1].id])
      .andWhere({ event_type: 'status_changed' });
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.from_status, 'waitlisted');
      assert.equal(event.to_status, 'booked');
      assert.equal(event.is_automatic, true);
      assert.equal(event.caused_by_booking_id, null);
      assert.equal(String(event.actor_user_id), String(fixture.staff.id));
    }
  });

  it('promotes fewer than freeSeats when the waitlist is shorter, with no error', async () => {
    const session = await insertSession({ startsAt: futureDate(302), capacity: 5 });
    const member = await insertMember(`fifo-short-${RUN}`);
    const booking = await insertBooking({ sessionId: session.id, memberId: member.id, status: 'waitlisted' });

    let promoted;
    await db.transaction(async (trx) => {
      promoted = await promoteWaitlistFIFO(trx, {
        sessionId: session.id,
        freeSeats: 5,
        actorUserId: fixture.staff.id,
      });
    });
    assert.equal(promoted.length, 1);
    assert.equal(String(promoted[0].id), String(booking.id));
  });

  it('records caused_by_booking_id = null for a capacity-increase promotion', async () => {
    const session = await insertSession({ startsAt: futureDate(303), capacity: 5 });
    const member = await insertMember(`fifo-capacity-${RUN}`);
    const booking = await insertBooking({ sessionId: session.id, memberId: member.id, status: 'waitlisted' });

    await db.transaction(async (trx) => {
      await promoteWaitlistFIFO(trx, {
        sessionId: session.id,
        freeSeats: 1,
        actorUserId: fixture.staff.id,
        causedByBookingId: null,
      });
    });

    const event = await db('booking_events').where({ booking_id: booking.id }).first();
    assert.equal(event.caused_by_booking_id, null);
    assert.equal(event.is_automatic, true);
  });

  it('never promotes a cancelled or already-booked row', async () => {
    const session = await insertSession({ startsAt: futureDate(304), capacity: 5 });
    const members = await Promise.all(['cancelled', 'booked'].map((s) => insertMember(`fifo-skip-${s}-${RUN}`)));
    await insertBooking({ sessionId: session.id, memberId: members[0].id, status: 'cancelled' });
    await insertBooking({ sessionId: session.id, memberId: members[1].id, status: 'booked' });

    let promoted;
    await db.transaction(async (trx) => {
      promoted = await promoteWaitlistFIFO(trx, {
        sessionId: session.id,
        freeSeats: 5,
        actorUserId: fixture.staff.id,
      });
    });
    assert.deepEqual(promoted, []);
  });
});

describe('translateBookingPgError', () => {
  it('maps 23505 (unique violation) to a 409 naming the duplicate-booking rule', () => {
    const translated = translateBookingPgError({ code: '23505' });
    assert.ok(translated instanceof BookingError);
    assert.equal(translated.status, 409);
  });

  it('maps 23503 (foreign key violation) to a 409', () => {
    const translated = translateBookingPgError({ code: '23503' });
    assert.ok(translated instanceof BookingError);
    assert.equal(translated.status, 409);
  });

  it('maps 55P03 (lock not available) to a 409', () => {
    const translated = translateBookingPgError({ code: '55P03' });
    assert.ok(translated instanceof BookingError);
    assert.equal(translated.status, 409);
  });

  it('returns null for an unrecognized error, so the caller rethrows it', () => {
    assert.equal(translateBookingPgError({ code: '42601' }), null);
    assert.equal(translateBookingPgError(new Error('boom')), null);
    assert.equal(translateBookingPgError(undefined), null);
  });
});
