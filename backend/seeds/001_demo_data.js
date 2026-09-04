import { hash, Algorithm } from '@node-rs/argon2';

import { env } from '../src/config/env.js';

/**
 * Deterministic demonstration data.
 *
 * IDEMPOTENCY, and why it is a guard rather than a delete.
 * The usual Knex seed pattern — delete everything, then insert — is impossible
 * here by design: `booking_events` rejects DELETE and TRUNCATE, so history
 * cannot be cleared. That is the point of the table, not an obstacle to work
 * around. So this seed is idempotent the honest way: it inserts on an empty
 * database and is a no-op on a seeded one. Rebuilding from scratch is
 * `npm run db:reset` (rollback → migrate → seed), which drops the tables
 * outright rather than pretending history can be erased.
 *
 * DETERMINISM.
 * Every name, relationship, capacity and status is fixed. Only two things vary
 * between runs, both deliberately: Argon2 salts (a fixed salt would be worse
 * than useless), and the anchor date. Dates are relative to the studio's civil
 * "today" so that "multiple future sessions" and "a member inside the
 * seven-day alert window" stay true whenever the seed is run, instead of
 * quietly going stale the way fixed calendar dates would.
 *
 * TIME HANDLING.
 * Local wall-clock strings are converted with `AT TIME ZONE` inside PostgreSQL
 * rather than by hand in JavaScript, so the IANA rules — including DST — are
 * applied by the database. This mirrors how the application will expand
 * recurring sessions: reason in local calendar terms, store instants.
 */

// --- civil-date helpers (pure calendar arithmetic, no zone maths) -----------

/** 'YYYY-MM-DD' + n days, treating the string as a bare calendar date. */
function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** An instant a given number of days/hours before a session's start. */
function before(instant, { days = 0, hours = 0 }) {
  return new Date(instant.getTime() - (days * 24 + hours) * 3_600_000);
}

// --- insert helpers ---------------------------------------------------------

async function insertSession(
  trx,
  { classId, instructorId, roomId, localStart, durationMinutes, capacity },
) {
  const { rows } = await trx.raw(
    `INSERT INTO sessions
       (class_id, primary_instructor_id, room_id, starts_at, duration_minutes, capacity)
     VALUES (?, ?, ?, (?::timestamp AT TIME ZONE ?), ?, ?)
     RETURNING id, starts_at`,
    [
      classId,
      instructorId,
      roomId,
      localStart,
      env.STUDIO_TIMEZONE,
      durationMinutes,
      capacity,
    ],
  );
  return rows[0];
}

/**
 * A booking and its opening `created` event, written together — the invariant
 * the application must also hold: `bookings.status` always equals the newest
 * event's `to_status`.
 *
 * `created_at` is set explicitly rather than defaulted. Inside one transaction
 * `now()` is the transaction start time, so defaulting would give every row in
 * the seed an identical timestamp and flatten both the waitlist FIFO order and
 * every booking timeline into a single instant.
 */
async function createBooking(
  trx,
  { sessionId, memberId, status, createdAt, actorId },
) {
  const [booking] = await trx('bookings')
    .insert({
      session_id: sessionId,
      member_id: memberId,
      status,
      created_at: createdAt,
      updated_at: createdAt,
    })
    .returning(['id']);

  await trx('booking_events').insert({
    booking_id: booking.id,
    event_type: 'created',
    to_status: status,
    actor_user_id: actorId,
    occurred_at: createdAt,
  });

  return booking.id;
}

async function changeStatus(
  trx,
  {
    bookingId,
    from,
    to,
    actorId,
    occurredAt,
    isAutomatic = false,
    causedByBookingId = null,
  },
) {
  await trx('bookings')
    .where({ id: bookingId })
    .update({ status: to, updated_at: occurredAt });

  await trx('booking_events').insert({
    booking_id: bookingId,
    event_type: 'status_changed',
    from_status: from,
    to_status: to,
    actor_user_id: actorId,
    is_automatic: isAutomatic,
    caused_by_booking_id: causedByBookingId,
    occurred_at: occurredAt,
  });
}

async function addNote(trx, { bookingId, note, actorId, occurredAt }) {
  await trx('booking_events').insert({
    booking_id: bookingId,
    event_type: 'note',
    note,
    actor_user_id: actorId,
    occurred_at: occurredAt,
  });
}

// --- the seed ---------------------------------------------------------------

export async function seed(knex) {
  const [{ count }] = await knex('users').count({ count: '*' });
  if (Number(count) > 0) {
    console.log(
      '  · database already seeded — skipping (use `npm run db:reset` to rebuild)',
    );
    return;
  }

  if (!env.SEED_PASSWORD) {
    throw new Error(
      'SEED_PASSWORD must be set to seed demo accounts. It is deliberately not ' +
        'defaulted so no password literal is ever committed. See backend/.env.example.',
    );
  }

  const passwordHash = () =>
    hash(env.SEED_PASSWORD, { algorithm: Algorithm.Argon2id });

  // The studio's civil today, resolved by PostgreSQL in STUDIO_TIMEZONE.
  const { rows: todayRows } = await knex.raw(
    `SELECT to_char((now() AT TIME ZONE ?)::date, 'YYYY-MM-DD') AS today`,
    [env.STUDIO_TIMEZONE],
  );
  const today = todayRows[0].today;

  await knex.transaction(async (trx) => {
    // -- rooms ---------------------------------------------------------------
    const rooms = await trx('rooms')
      .insert([
        { name: 'Studio A' },
        { name: 'Studio B' },
        { name: 'The Loft' },
      ])
      .returning(['id', 'name']);
    const room = Object.fromEntries(rooms.map((r) => [r.name, r.id]));

    // -- users ---------------------------------------------------------------
    // Leila is retained but deactivated: a departed instructor who has already
    // taught. Every FK into `users` is RESTRICT, so she cannot be deleted —
    // `is_active` is the only way to revoke access, which is exactly why the
    // column exists.
    const users = await trx('users')
      .insert([
        {
          email: 'ada.okonkwo@studio.test',
          full_name: 'Ada Okonkwo',
          role: 'staff',
          password_hash: await passwordHash(),
        },
        {
          email: 'marco.silva@studio.test',
          full_name: 'Marco Silva',
          role: 'instructor',
          password_hash: await passwordHash(),
        },
        {
          email: 'priya.raman@studio.test',
          full_name: 'Priya Raman',
          role: 'instructor',
          password_hash: await passwordHash(),
        },
        {
          email: 'jonas.weber@studio.test',
          full_name: 'Jonas Weber',
          role: 'instructor',
          password_hash: await passwordHash(),
        },
        {
          email: 'leila.haddad@studio.test',
          full_name: 'Leila Haddad',
          role: 'instructor',
          is_active: false,
          password_hash: await passwordHash(),
        },
      ])
      .returning(['id', 'email']);
    const user = Object.fromEntries(
      users.map((u) => [u.email.split('.')[0], u.id]),
    );
    const staffId = user.ada;

    // -- members -------------------------------------------------------------
    // Every member here has a distinct email — `members.email` is UNIQUE as of
    // migration 014 (see that migration and docs/decisions.md for why the
    // earlier "one household email on two memberships" design was reversed).
    // Oscar and Elsa Lindqvist previously shared one address to demonstrate
    // that non-uniqueness; they now have their own, matching every other
    // member in this seed.
    const members = await trx('members')
      .insert([
        {
          full_name: 'Nadia Fischer',
          email: 'nadia.fischer@example.com',
          membership_expires_on: addDays(today, 180),
        },
        {
          full_name: 'Tomas Berg',
          email: 'tomas.berg@example.com',
          membership_expires_on: addDays(today, 95),
        },
        {
          full_name: 'Ivy Chen',
          email: 'ivy.chen@example.com',
          membership_expires_on: addDays(today, 40),
        },
        {
          full_name: 'Ravi Sharma',
          email: 'ravi.sharma@example.com',
          membership_expires_on: addDays(today, 3), // inside the alert window
        },
        {
          full_name: 'Grace Mwangi',
          email: 'grace.mwangi@example.com',
          membership_expires_on: addDays(today, -12), // lapsed
        },
        {
          full_name: 'Oscar Lindqvist',
          email: 'oscar.lindqvist@example.com',
          membership_expires_on: addDays(today, 5), // inside the alert window
        },
        {
          full_name: 'Elsa Lindqvist',
          email: 'elsa.lindqvist@example.com',
          membership_expires_on: addDays(today, 200),
        },
        {
          full_name: 'Daniel Osei',
          email: 'daniel.osei@example.com',
          membership_expires_on: addDays(today, 6), // in window, but dismissed
        },
        {
          full_name: 'Marta Nowak',
          email: 'marta.nowak@example.com',
          membership_expires_on: addDays(today, 365),
        },
      ])
      .returning(['id', 'full_name']);
    const member = Object.fromEntries(
      members.map((m) => [m.full_name.split(' ')[0].toLowerCase(), m.id]),
    );

    // -- classes -------------------------------------------------------------
    const classes = await trx('classes')
      .insert([
        {
          title: 'Vinyasa Flow',
          discipline: 'Yoga',
          description: 'Breath-led flow for all levels.',
          default_duration_minutes: 60,
          default_capacity: 12,
        },
        {
          title: 'Contemporary Technique',
          discipline: 'Dance',
          description: 'Floorwork, release technique and travelling phrases.',
          default_duration_minutes: 90,
          default_capacity: 16,
        },
        {
          title: 'Beginner Ballet',
          discipline: 'Dance',
          description: 'Barre fundamentals and simple centre work.',
          default_duration_minutes: 60,
          default_capacity: 14,
        },
        {
          title: 'Strength & Conditioning',
          discipline: 'Fitness',
          description: 'Compound lifts and accessory work for dancers.',
          default_duration_minutes: 45,
          default_capacity: 10,
        },
        {
          // Archived, and deliberately still carrying sessions and bookings:
          // archiving hides a class from default views without destroying
          // anything beneath it.
          title: 'Aerial Hoop Foundations',
          discipline: 'Aerial',
          description: 'Retired from the timetable while the rig is inspected.',
          default_duration_minutes: 75,
          default_capacity: 8,
          archived_at: knex.raw('now()'),
        },
      ])
      .returning(['id', 'title']);
    const klass = Object.fromEntries(classes.map((c) => [c.title, c.id]));

    // -- sessions ------------------------------------------------------------
    // Capacities below deliberately differ from the class defaults in places:
    // session capacity is copied on create, not referenced, so a session may
    // legitimately diverge from the class it came from.
    const vinyasaUpcoming = await insertSession(trx, {
      classId: klass['Vinyasa Flow'],
      instructorId: user.marco,
      roomId: room['Studio A'],
      localStart: `${addDays(today, 2)} 18:00`,
      durationMinutes: 60,
      capacity: 12,
    });

    const vinyasaWeek2 = await insertSession(trx, {
      classId: klass['Vinyasa Flow'],
      instructorId: user.marco,
      roomId: room['Studio A'],
      localStart: `${addDays(today, 9)} 18:00`,
      durationMinutes: 60,
      capacity: 12,
    });

    const vinyasaWeek3 = await insertSession(trx, {
      classId: klass['Vinyasa Flow'],
      instructorId: user.marco,
      roomId: room['Studio A'],
      localStart: `${addDays(today, 16)} 18:00`,
      durationMinutes: 60,
      capacity: 12,
    });

    // Full, with a waitlist behind it.
    const contemporaryFull = await insertSession(trx, {
      classId: klass['Contemporary Technique'],
      instructorId: user.priya,
      roomId: room['Studio B'],
      localStart: `${addDays(today, 3)} 19:30`,
      durationMinutes: 90,
      capacity: 6,
    });

    // Where the cancellation → automatic promotion story is told.
    const balletUpcoming = await insertSession(trx, {
      classId: klass['Beginner Ballet'],
      instructorId: user.jonas,
      roomId: room['Studio A'],
      localStart: `${addDays(today, 4)} 17:00`,
      durationMinutes: 60,
      capacity: 3,
    });

    const contemporaryLater = await insertSession(trx, {
      classId: klass['Contemporary Technique'],
      instructorId: user.priya,
      roomId: room['Studio B'],
      localStart: `${addDays(today, 10)} 19:30`,
      durationMinutes: 90,
      capacity: 16,
    });

    // Past, settled — attendance and no-shows.
    const strengthPast = await insertSession(trx, {
      classId: klass['Strength & Conditioning'],
      instructorId: user.marco,
      roomId: room['The Loft'],
      localStart: `${addDays(today, -7)} 07:00`,
      durationMinutes: 45,
      capacity: 10,
    });

    const vinyasaPast = await insertSession(trx, {
      classId: klass['Vinyasa Flow'],
      instructorId: user.priya,
      roomId: room['Studio A'],
      localStart: `${addDays(today, -14)} 18:00`,
      durationMinutes: 60,
      capacity: 12,
    });

    // Archived class, past session, with bookings that survived archiving.
    const aerialPast = await insertSession(trx, {
      classId: klass['Aerial Hoop Foundations'],
      instructorId: user.leila,
      roomId: room['The Loft'],
      localStart: `${addDays(today, -21)} 20:00`,
      durationMinutes: 75,
      capacity: 8,
    });

    // Archived class, future session: archiving means "stop scheduling this",
    // not "cancel what is already scheduled".
    const aerialUpcoming = await insertSession(trx, {
      classId: klass['Aerial Hoop Foundations'],
      instructorId: user.leila,
      roomId: room['The Loft'],
      localStart: `${addDays(today, 11)} 20:00`,
      durationMinutes: 75,
      capacity: 8,
    });

    // -- co-instructors ------------------------------------------------------
    await trx('session_co_instructors').insert([
      {
        session_id: vinyasaUpcoming.id,
        user_id: user.priya,
        session_primary_instructor_id: user.marco,
      },
      {
        session_id: contemporaryFull.id,
        user_id: user.jonas,
        session_primary_instructor_id: user.priya,
      },
      {
        session_id: contemporaryLater.id,
        user_id: user.marco,
        session_primary_instructor_id: user.priya,
      },
      {
        session_id: contemporaryLater.id,
        user_id: user.jonas,
        session_primary_instructor_id: user.priya,
      },
    ]);

    // -- bookings ------------------------------------------------------------

    // A quiet upcoming session: room to spare.
    for (const [index, memberId] of [
      member.nadia,
      member.tomas,
      member.ivy,
    ].entries()) {
      await createBooking(trx, {
        sessionId: vinyasaUpcoming.id,
        memberId,
        status: 'booked',
        createdAt: before(vinyasaUpcoming.starts_at, {
          days: 5,
          hours: index,
        }),
        actorId: staffId,
      });
    }

    await createBooking(trx, {
      sessionId: vinyasaWeek2.id,
      memberId: member.nadia,
      status: 'booked',
      createdAt: before(vinyasaWeek2.starts_at, { days: 6 }),
      actorId: staffId,
    });

    await createBooking(trx, {
      sessionId: vinyasaWeek3.id,
      memberId: member.marta,
      status: 'booked',
      createdAt: before(vinyasaWeek3.starts_at, { days: 6 }),
      actorId: staffId,
    });

    // Full session: six seats taken, two waiting. Staggered creation times give
    // the waitlist a real FIFO order rather than a tie broken only by id.
    const fullSeats = [
      member.nadia,
      member.tomas,
      member.ivy,
      member.elsa,
      member.marta,
      member.daniel,
    ];
    for (const [index, memberId] of fullSeats.entries()) {
      await createBooking(trx, {
        sessionId: contemporaryFull.id,
        memberId,
        status: 'booked',
        createdAt: before(contemporaryFull.starts_at, {
          days: 9,
          hours: -index,
        }),
        actorId: staffId,
      });
    }
    for (const [index, memberId] of [member.oscar, member.ravi].entries()) {
      await createBooking(trx, {
        sessionId: contemporaryFull.id,
        memberId,
        status: 'waitlisted',
        createdAt: before(contemporaryFull.starts_at, {
          days: 4,
          hours: -index,
        }),
        actorId: staffId,
      });
    }

    // Cancellation and the automatic promotion it caused.
    const balletBooked = [];
    for (const [index, memberId] of [
      member.tomas,
      member.ivy,
      member.marta,
    ].entries()) {
      balletBooked.push(
        await createBooking(trx, {
          sessionId: balletUpcoming.id,
          memberId,
          status: 'booked',
          createdAt: before(balletUpcoming.starts_at, {
            days: 8,
            hours: -index,
          }),
          actorId: staffId,
        }),
      );
    }
    const balletWaitlistFirst = await createBooking(trx, {
      sessionId: balletUpcoming.id,
      memberId: member.nadia,
      status: 'waitlisted',
      createdAt: before(balletUpcoming.starts_at, { days: 6 }),
      actorId: staffId,
    });
    await createBooking(trx, {
      sessionId: balletUpcoming.id,
      memberId: member.daniel,
      status: 'waitlisted',
      createdAt: before(balletUpcoming.starts_at, { days: 5 }),
      actorId: staffId,
    });

    const cancelledAt = before(balletUpcoming.starts_at, { days: 2 });
    await changeStatus(trx, {
      bookingId: balletBooked[1],
      from: 'booked',
      to: 'cancelled',
      actorId: staffId,
      occurredAt: cancelledAt,
    });
    // Atomic with the cancellation, and attributed: automatic events still name
    // the human whose action triggered them.
    await changeStatus(trx, {
      bookingId: balletWaitlistFirst,
      from: 'waitlisted',
      to: 'booked',
      actorId: staffId,
      occurredAt: cancelledAt,
      isAutomatic: true,
      causedByBookingId: balletBooked[1],
    });
    await addNote(trx, {
      bookingId: balletBooked[1],
      note: 'Cancelled by phone — travelling for work.',
      actorId: staffId,
      occurredAt: cancelledAt,
    });

    await createBooking(trx, {
      sessionId: contemporaryLater.id,
      memberId: member.oscar,
      status: 'booked',
      createdAt: before(contemporaryLater.starts_at, { days: 7 }),
      actorId: staffId,
    });

    // Archived class keeps its future booking.
    await createBooking(trx, {
      sessionId: aerialUpcoming.id,
      memberId: member.ivy,
      status: 'booked',
      createdAt: before(aerialUpcoming.starts_at, { days: 12 }),
      actorId: staffId,
    });

    // -- settled past sessions ----------------------------------------------
    // Grace's membership has since lapsed; these were booked while it was
    // valid, which is exactly how the data should look.
    const settled = [
      {
        session: strengthPast,
        rows: [
          [member.nadia, 'attended'],
          [member.tomas, 'attended'],
          [member.ivy, 'attended'],
          [member.grace, 'attended'],
          [member.marta, 'no_show'],
          [member.daniel, 'no_show'],
        ],
      },
      {
        session: vinyasaPast,
        rows: [
          [member.nadia, 'attended'],
          [member.elsa, 'attended'],
          [member.oscar, 'attended'],
          [member.tomas, 'attended'],
          [member.ravi, 'attended'],
          [member.grace, 'no_show'],
        ],
      },
      {
        session: aerialPast,
        rows: [
          [member.ivy, 'attended'],
          [member.marta, 'attended'],
          [member.daniel, 'no_show'],
        ],
      },
    ];

    for (const { session, rows } of settled) {
      for (const [index, [memberId, finalStatus]] of rows.entries()) {
        const bookingId = await createBooking(trx, {
          sessionId: session.id,
          memberId,
          status: 'booked',
          createdAt: before(session.starts_at, { days: 7, hours: -index }),
          actorId: staffId,
        });
        // Settlement happens after the session has finished.
        await changeStatus(trx, {
          bookingId,
          from: 'booked',
          to: finalStatus,
          actorId: staffId,
          occurredAt: new Date(
            session.starts_at.getTime() + 2 * 3_600_000,
          ),
        });
      }
    }

    await addNote(trx, {
      bookingId: await trx('bookings')
        .where({ session_id: strengthPast.id, member_id: member.daniel })
        .first('id')
        .then((row) => row.id),
      note: 'Called ahead — stuck on a delayed train.',
      actorId: staffId,
      occurredAt: new Date(strengthPast.starts_at.getTime() + 3 * 3_600_000),
    });

    // -- alert dismissal -----------------------------------------------------
    // Daniel is inside the seven-day window but staff have actioned him. If his
    // expiry is later moved and again falls within seven days, the anti-join
    // stops matching this row and the alert returns on its own.
    await trx('member_alert_dismissals').insert({
      member_id: member.daniel,
      dismissed_expiry_date: addDays(today, 6),
      dismissed_by_user_id: staffId,
    });
  });

  const counts = await Promise.all(
    [
      'users',
      'members',
      'rooms',
      'classes',
      'sessions',
      'session_co_instructors',
      'bookings',
      'booking_events',
      'member_alert_dismissals',
    ].map(async (table) => {
      const [{ count }] = await knex(table).count({ count: '*' });
      return `${table}=${count}`;
    }),
  );
  console.log(`  · seeded: ${counts.join(' ')}`);
}
