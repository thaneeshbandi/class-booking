import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import knexFactory from 'knex';

import { db, closeConnection } from '../src/db/knex.js';
import { connection } from '../knexfile.js';

/**
 * Schema verification against a live PostgreSQL database.
 *
 * These are not unit tests of application code — there is no application code
 * yet. They assert that the migrations actually produced the approved schema
 * and that its constraints actually reject what they claim to reject. Reading
 * the migration files proves nothing; PostgreSQL is the only authority on what
 * was built.
 *
 * Every mutating test runs inside a transaction that is always rolled back, so
 * the suite can be run repeatedly against a seeded database without changing
 * it. Rollback is also the only way to undo a `booking_events` insert: the
 * table rejects DELETE by design.
 */

const DOMAIN_TABLES = [
  'users',
  'members',
  'rooms',
  'classes',
  'sessions',
  'session_co_instructors',
  'bookings',
  'booking_events',
  'member_alert_dismissals',
  'password_reset_otps',
];

const EXPECTED_INDEXES = [
  'users_pkey',
  'users_email_unique',
  'members_pkey',
  'members_membership_expires_on',
  'members_user_id_unique',
  'members_email_unique',
  'rooms_pkey',
  'rooms_name_ci_unique',
  'classes_pkey',
  'sessions_pkey',
  'sessions_id_instructor_key',
  'sessions_instructor_starts_at',
  'sessions_class_starts_at',
  'sessions_room_starts_at',
  'sessions_starts_at',
  'session_co_instructors_pkey',
  'session_co_instructors_user',
  'bookings_pkey',
  'bookings_one_active_per_member_session',
  'bookings_session_status',
  'bookings_created_at',
  'bookings_member',
  'bookings_waitlist_fifo',
  'booking_events_pkey',
  'booking_events_booking',
  'member_alert_dismissals_pkey',
  'member_alert_dismissals_unique',
  'password_reset_otps_pkey',
  'password_reset_otps_user_id_created_at',
];

const EXPECTED_CHECK_CONSTRAINTS = [
  'users_email_normalised',
  'users_email_shape',
  'users_name_present',
  'users_hash_not_plain',
  'members_email_normalised',
  'members_email_shape',
  'members_name_present',
  'rooms_name_present',
  'classes_title_present',
  'classes_discipline_present',
  'classes_duration_positive',
  'classes_capacity_positive',
  'sessions_duration_positive',
  'sessions_capacity_positive',
  'co_instructor_is_not_primary',
  'booking_events_well_formed',
  'booking_events_automatic_is_status_change',
  'booking_events_automatic_has_actor',
  'booking_events_cause_requires_automatic',
  'booking_events_cause_is_not_self',
];

/**
 * Runs `fn` inside a transaction that is always rolled back, and returns the
 * error it raised (or null). Each expected failure needs its own transaction:
 * once a statement fails, PostgreSQL aborts the transaction and every later
 * statement in it fails with "current transaction is aborted".
 */
async function attempt(fn) {
  const trx = await db.transaction();
  let error = null;
  try {
    await fn(trx);
  } catch (caught) {
    error = caught;
  }
  try {
    await trx.rollback();
  } catch {
    // Already aborted by the failing statement; nothing further to undo.
  }
  return error;
}

async function succeeds(fn) {
  const error = await attempt(fn);
  assert.equal(
    error,
    null,
    `expected success but got: ${error?.message ?? ''}`,
  );
}

async function failsWith(code, fn) {
  const error = await attempt(fn);
  assert.notEqual(error, null, 'expected the statement to be rejected');
  assert.equal(
    error.code,
    code,
    `expected SQLSTATE ${code}, got ${error.code}: ${error.message}`,
  );
  return error;
}

const fixture = {};

before(async () => {
  fixture.staff = await db('users').where({ role: 'staff' }).first('id');
  fixture.instructors = await db('users')
    .where({ role: 'instructor' })
    .orderBy('id')
    .select('id');
  fixture.member = await db('members').orderBy('id').first('id');
  fixture.otherMember = await db('members').orderBy('id', 'desc').first('id');
  fixture.class = await db('classes').whereNull('archived_at').first('id');
  fixture.room = await db('rooms').orderBy('id').first('id');
  fixture.session = await db('sessions').orderBy('id').first('id');

  // A session that already carries co-instructors, for the cascade test.
  fixture.coInstructed = await db('session_co_instructors')
    .orderBy('session_id')
    .first('session_id', 'user_id', 'session_primary_instructor_id');

  fixture.booking = await db('bookings')
    .where({ status: 'booked' })
    .orderBy('id')
    .first('id', 'session_id', 'member_id');

  fixture.event = await db('booking_events').orderBy('id').first('id');

  assert.ok(fixture.staff, 'seed data is required: run `npm run db:seed`');
});

after(async () => {
  await closeConnection();
});

describe('4. tables', () => {
  it('every domain table exists, and only those ten', async () => {
    const { rows } = await db.raw(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name NOT LIKE 'knex_%'
      ORDER BY table_name
    `);
    const found = rows.map((r) => r.table_name);
    assert.deepEqual(found, [...DOMAIN_TABLES].sort());
    // Nine from the original ten mandatory goals, plus `password_reset_otps`
    // (migration 013 — the account/member-linking and forgot-password
    // milestone).
    assert.equal(found.length, 10, 'the schema is exactly ten domain tables');
  });

  it('the three enum types exist with the approved values', async () => {
    const { rows } = await db.raw(`
      SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      GROUP BY t.typname ORDER BY t.typname
    `);
    const byName = Object.fromEntries(rows.map((r) => [r.typname, r.labels]));
    // 'member' (migration 011) is a deliberate, approved third value for
    // public self-service signup — see that migration's own comment for why
    // it carries no elevated access anywhere in the API.
    assert.equal(byName.user_role, 'staff,instructor,member');
    // Declaration order is load-bearing: it is what makes "sort by status"
    // produce lifecycle order rather than alphabetical order.
    assert.equal(
      byName.booking_status,
      'booked,waitlisted,cancelled,attended,no_show',
    );
    assert.equal(byName.booking_event_type, 'created,status_changed,note');
  });

  it('has no booked_count column anywhere', async () => {
    const { rows } = await db.raw(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ILIKE '%booked_count%'
    `);
    assert.deepEqual(rows, []);
  });

  it('installs no extensions and declares no EXCLUDE constraints', async () => {
    const { rows: ext } = await db.raw(`
      SELECT extname FROM pg_extension WHERE extname <> 'plpgsql'
    `);
    assert.deepEqual(ext, [], 'no btree_gist, no pg_trgm, no citext');

    const { rows: excl } = await db.raw(`
      SELECT conname FROM pg_constraint WHERE contype = 'x'
    `);
    assert.deepEqual(excl, []);
  });
});

describe('5. indexes', () => {
  it('every approved index exists', async () => {
    const { rows } = await db.raw(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename NOT LIKE 'knex_%'
    `);
    const found = new Set(rows.map((r) => r.indexname));
    for (const name of EXPECTED_INDEXES) {
      assert.ok(found.has(name), `missing index: ${name}`);
    }
    assert.equal(found.size, EXPECTED_INDEXES.length, 'no unexpected indexes');
  });

  it('the active-booking index is partial on exactly booked+waitlisted', async () => {
    const { rows } = await db.raw(`
      SELECT indexdef FROM pg_indexes
      WHERE indexname = 'bookings_one_active_per_member_session'
    `);
    const def = rows[0].indexdef;
    assert.match(def, /UNIQUE/);
    assert.match(def, /WHERE \(status = ANY \(.*booked.*waitlisted.*\)\)/s);
    assert.doesNotMatch(def, /cancelled|attended|no_show/);
  });

  it('the waitlist index is partial and ordered for FIFO promotion', async () => {
    const { rows } = await db.raw(`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'bookings_waitlist_fifo'
    `);
    assert.match(rows[0].indexdef, /\(session_id, created_at, id\)/);
    assert.match(rows[0].indexdef, /WHERE \(status = 'waitlisted'/);
  });

  it('room name uniqueness is case-insensitive via lower(name)', async () => {
    const { rows } = await db.raw(`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'rooms_name_ci_unique'
    `);
    assert.match(rows[0].indexdef, /UNIQUE.*lower\(name\)/);
  });
});

describe('6. constraints', () => {
  it('every approved CHECK constraint exists', async () => {
    const { rows } = await db.raw(`
      SELECT conname FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND c.contype = 'c'
    `);
    const found = new Set(rows.map((r) => r.conname));
    for (const name of EXPECTED_CHECK_CONSTRAINTS) {
      assert.ok(found.has(name), `missing CHECK constraint: ${name}`);
    }
  });

  it('duration requires >= 1 with no upper bound', async () => {
    const { rows } = await db.raw(`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('sessions_duration_positive', 'classes_duration_positive')
    `);
    for (const row of rows) {
      assert.match(row.def, />= 1/);
      assert.doesNotMatch(row.def, /1440/, 'the 1440 ceiling must be gone');
    }
  });

  it('accepts a session longer than a day, and rejects zero', async () => {
    // A 30-hour intensive is a legitimate booking; the schema must not forbid it.
    await succeeds((trx) =>
      trx('sessions').insert({
        class_id: fixture.class.id,
        primary_instructor_id: fixture.instructors[0].id,
        room_id: fixture.room.id,
        starts_at: new Date(),
        duration_minutes: 1800,
        capacity: 5,
      }),
    );

    await failsWith('23514', (trx) =>
      trx('sessions').insert({
        class_id: fixture.class.id,
        primary_instructor_id: fixture.instructors[0].id,
        room_id: fixture.room.id,
        starts_at: new Date(),
        duration_minutes: 0,
        capacity: 5,
      }),
    );
  });

  it('rejects non-positive capacity', async () => {
    await failsWith('23514', (trx) =>
      trx('sessions').insert({
        class_id: fixture.class.id,
        primary_instructor_id: fixture.instructors[0].id,
        room_id: fixture.room.id,
        starts_at: new Date(),
        duration_minutes: 60,
        capacity: 0,
      }),
    );
  });

  it('enforces case-insensitive login email uniqueness', async () => {
    const existing = await db('users').first('email');

    // Storage normalisation is what makes plain UNIQUE(email) case-insensitive.
    await failsWith('23514', (trx) =>
      trx('users').insert({
        email: existing.email.toUpperCase(),
        full_name: 'Case Test',
        role: 'staff',
        password_hash: '$argon2id$fake',
      }),
    );

    await failsWith('23505', (trx) =>
      trx('users').insert({
        email: existing.email,
        full_name: 'Duplicate Test',
        role: 'staff',
        password_hash: '$argon2id$fake',
      }),
    );
  });

  it('rejects a password hash that is not a PHC string', async () => {
    await failsWith('23514', (trx) =>
      trx('users').insert({
        email: 'plaintext@studio.test',
        full_name: 'Plaintext Test',
        role: 'staff',
        password_hash: 'hunter2',
      }),
    );
  });

  it('rejects two members sharing an email address', async () => {
    // Until migration 014, this was deliberately allowed — a member was
    // identified by its row, not its address (one parent's email on two
    // children's memberships was considered ordinary). Reversed on an
    // explicit product requirement; see docs/decisions.md.
    const existing = await db('members').first('email');
    await failsWith('23505', (trx) =>
      trx('members').insert({
        full_name: 'Duplicate Email Test',
        email: existing.email,
        membership_expires_on: '2027-01-01',
      }),
    );
  });

  it('storage normalization is what makes members.email uniqueness case-insensitive, the same as users.email', async () => {
    const existing = await db('members').first('email');
    // A raw, not-yet-normalized INSERT is rejected by the normalization
    // CHECK before it ever reaches the uniqueness check — the exact same
    // two-layer shape the `users.email` test above already documents.
    await failsWith('23514', (trx) =>
      trx('members').insert({
        full_name: 'Duplicate Email Case Test',
        email: existing.email.toUpperCase(),
        membership_expires_on: '2027-01-01',
      }),
    );
  });

  it('enforces one alert dismissal per member and expiry date', async () => {
    const existing = await db('member_alert_dismissals').first(
      'member_id',
      'dismissed_expiry_date',
    );
    await failsWith('23505', (trx) =>
      trx('member_alert_dismissals').insert({
        member_id: existing.member_id,
        dismissed_expiry_date: existing.dismissed_expiry_date,
        dismissed_by_user_id: fixture.staff.id,
      }),
    );
  });
});

describe('7. booking_events immutability', () => {
  it('rejects UPDATE', async () => {
    const error = await failsWith('23001', (trx) =>
      trx('booking_events').where({ id: fixture.event.id }).update({ note: 'tampered' }),
    );
    assert.match(error.message, /append-only/);
    assert.match(error.message, /UPDATE/);
  });

  it('rejects DELETE', async () => {
    const error = await failsWith('23001', (trx) =>
      trx('booking_events').where({ id: fixture.event.id }).del(),
    );
    assert.match(error.message, /DELETE/);
  });

  it('rejects TRUNCATE', async () => {
    // Row-level triggers do not fire on TRUNCATE; this proves the separate
    // statement-level trigger is doing its job.
    const error = await failsWith('23001', (trx) =>
      trx.raw('TRUNCATE booking_events'),
    );
    assert.match(error.message, /TRUNCATE/);
  });

  it('still accepts INSERT', async () => {
    await succeeds((trx) =>
      trx('booking_events').insert({
        booking_id: fixture.booking.id,
        event_type: 'note',
        note: 'Append is the only permitted write.',
        actor_user_id: fixture.staff.id,
      }),
    );
  });

  it('requires an actor on automatic events', async () => {
    await failsWith('23514', (trx) =>
      trx('booking_events').insert({
        booking_id: fixture.booking.id,
        event_type: 'status_changed',
        from_status: 'waitlisted',
        to_status: 'booked',
        is_automatic: true,
        actor_user_id: null,
      }),
    );
  });

  it('allows a null actor on a non-automatic event (system/seed)', async () => {
    await succeeds((trx) =>
      trx('booking_events').insert({
        booking_id: fixture.booking.id,
        event_type: 'note',
        note: 'System-generated note with no human actor.',
        actor_user_id: null,
      }),
    );
  });

  it('rejects malformed event rows', async () => {
    // A `created` event carrying a from_status.
    await failsWith('23514', (trx) =>
      trx('booking_events').insert({
        booking_id: fixture.booking.id,
        event_type: 'created',
        from_status: 'booked',
        to_status: 'booked',
      }),
    );

    // A no-op status change.
    await failsWith('23514', (trx) =>
      trx('booking_events').insert({
        booking_id: fixture.booking.id,
        event_type: 'status_changed',
        from_status: 'booked',
        to_status: 'booked',
        actor_user_id: fixture.staff.id,
      }),
    );

    // An empty note.
    await failsWith('23514', (trx) =>
      trx('booking_events').insert({
        booking_id: fixture.booking.id,
        event_type: 'note',
        note: '   ',
        actor_user_id: fixture.staff.id,
      }),
    );

    // A cause without is_automatic.
    await failsWith('23514', (trx) =>
      trx('booking_events').insert({
        booking_id: fixture.booking.id,
        event_type: 'status_changed',
        from_status: 'booked',
        to_status: 'cancelled',
        actor_user_id: fixture.staff.id,
        caused_by_booking_id: fixture.booking.id,
      }),
    );
  });
});

describe('8. active-booking partial unique index', () => {
  it('rejects a second active booking for the same member and session', async () => {
    await failsWith('23505', (trx) =>
      trx('bookings').insert({
        session_id: fixture.booking.session_id,
        member_id: fixture.booking.member_id,
        status: 'booked',
      }),
    );
  });

  it('rejects booked + waitlisted for the same member and session', async () => {
    await failsWith('23505', (trx) =>
      trx('bookings').insert({
        session_id: fixture.booking.session_id,
        member_id: fixture.booking.member_id,
        status: 'waitlisted',
      }),
    );
  });

  it('allows a new booking alongside a cancelled one', async () => {
    // Cancelled is a withdrawn claim, not a live one: re-booking must work.
    await succeeds(async (trx) => {
      const cancelled = await trx('bookings')
        .where({ status: 'cancelled' })
        .first('session_id', 'member_id');
      await trx('bookings').insert({
        session_id: cancelled.session_id,
        member_id: cancelled.member_id,
        status: 'booked',
      });
    });
  });

  it('allows a new booking alongside a settled one', async () => {
    await succeeds(async (trx) => {
      const settled = await trx('bookings')
        .where({ status: 'attended' })
        .first('session_id', 'member_id');
      await trx('bookings').insert({
        session_id: settled.session_id,
        member_id: settled.member_id,
        status: 'booked',
      });
    });
  });
});

describe('9. co-instructor constraints', () => {
  it('rejects adding the primary instructor as a co-instructor', async () => {
    const session = await db('sessions')
      .orderBy('id')
      .first('id', 'primary_instructor_id');

    await failsWith('23514', (trx) =>
      trx('session_co_instructors').insert({
        session_id: session.id,
        user_id: session.primary_instructor_id,
        session_primary_instructor_id: session.primary_instructor_id,
      }),
    );
  });

  it('rejects a duplicate session/user pair', async () => {
    await failsWith('23505', (trx) =>
      trx('session_co_instructors').insert({
        session_id: fixture.coInstructed.session_id,
        user_id: fixture.coInstructed.user_id,
        session_primary_instructor_id:
          fixture.coInstructed.session_primary_instructor_id,
      }),
    );
  });

  it('rejects a join row whose denormalised primary does not match the session', async () => {
    // The composite FK is what keeps the denormalised column honest.
    const wrongPrimary = fixture.instructors.find(
      (i) => i.id !== fixture.coInstructed.session_primary_instructor_id,
    );
    await failsWith('23503', (trx) =>
      trx('session_co_instructors').insert({
        session_id: fixture.coInstructed.session_id,
        user_id: fixture.staff.id,
        session_primary_instructor_id: wrongPrimary.id,
      }),
    );
  });

  it('aborts when a session is re-pointed at one of its own co-instructors', async () => {
    // ON UPDATE CASCADE pushes the new primary into the join row, where the
    // CHECK rejects it and the whole transaction fails. The application must
    // remove the co-instructor row first, in the same transaction.
    await failsWith('23514', (trx) =>
      trx('sessions')
        .where({ id: fixture.coInstructed.session_id })
        .update({ primary_instructor_id: fixture.coInstructed.user_id }),
    );
  });

  it('allows the swap when the co-instructor row is removed first', async () => {
    await succeeds(async (trx) => {
      await trx('session_co_instructors')
        .where({
          session_id: fixture.coInstructed.session_id,
          user_id: fixture.coInstructed.user_id,
        })
        .del();
      await trx('sessions')
        .where({ id: fixture.coInstructed.session_id })
        .update({ primary_instructor_id: fixture.coInstructed.user_id });
    });
  });
});

describe('10. foreign key deletion behaviour', () => {
  it('refuses to delete a session that has bookings', async () => {
    await failsWith('23503', (trx) =>
      trx('sessions').where({ id: fixture.booking.session_id }).del(),
    );
  });

  it('refuses to delete a member that has bookings', async () => {
    await failsWith('23503', (trx) =>
      trx('members').where({ id: fixture.booking.member_id }).del(),
    );
  });

  it('refuses to delete a class that has sessions', async () => {
    await failsWith('23503', (trx) =>
      trx('classes').where({ id: fixture.class.id }).del(),
    );
  });

  it('refuses to delete a user who acted in booking history', async () => {
    // History must stay resolvable: "who made it" cannot become a dangling id.
    await failsWith('23503', (trx) =>
      trx('users').where({ id: fixture.staff.id }).del(),
    );
  });

  it('refuses to delete a room that has hosted a session', async () => {
    await failsWith('23503', (trx) =>
      trx('rooms').where({ id: fixture.room.id }).del(),
    );
  });

  it('cascades co-instructors when a booking-free session is deleted', async () => {
    await succeeds(async (trx) => {
      const [session] = await trx('sessions')
        .insert({
          class_id: fixture.class.id,
          primary_instructor_id: fixture.instructors[0].id,
          room_id: fixture.room.id,
          starts_at: new Date(),
          duration_minutes: 60,
          capacity: 5,
        })
        .returning(['id']);

      await trx('session_co_instructors').insert({
        session_id: session.id,
        user_id: fixture.instructors[1].id,
        session_primary_instructor_id: fixture.instructors[0].id,
      });

      await trx('sessions').where({ id: session.id }).del();

      const remaining = await trx('session_co_instructors')
        .where({ session_id: session.id })
        .count({ count: '*' });
      assert.equal(Number(remaining[0].count), 0);
    });
  });

  it('cascades alert dismissals when a booking-free member is deleted', async () => {
    await succeeds(async (trx) => {
      const [member] = await trx('members')
        .insert({
          full_name: 'Deletable Member',
          email: 'deletable@example.com',
          membership_expires_on: '2027-01-01',
        })
        .returning(['id']);

      await trx('member_alert_dismissals').insert({
        member_id: member.id,
        dismissed_expiry_date: '2027-01-01',
        dismissed_by_user_id: fixture.staff.id,
      });

      await trx('members').where({ id: member.id }).del();

      const remaining = await trx('member_alert_dismissals')
        .where({ member_id: member.id })
        .count({ count: '*' });
      assert.equal(Number(remaining[0].count), 0);
    });
  });
});

describe('grants: the least-privileged application role', () => {
  // Only runs when APP_DB_URL points at a role that is NOT the table owner.
  // The trigger protects history regardless; this proves the second layer.
  const appUrl = process.env.APP_DB_URL;

  it(
    'cannot UPDATE booking_events even before the trigger runs',
    { skip: appUrl ? false : 'APP_DB_URL not set' },
    async () => {
      const appDb = knexFactory({
        client: 'pg',
        connection: { connectionString: appUrl, ssl: connection.ssl },
        pool: { min: 0, max: 2 },
      });
      try {
        const error = await appDb('booking_events')
          .where({ id: fixture.event.id })
          .update({ note: 'tampered' })
          .then(() => null, (e) => e);

        assert.notEqual(error, null);
        // 42501 = insufficient_privilege: rejected by the grant, not the
        // trigger. Two layers that fail differently.
        assert.equal(error.code, '42501');

        // Rolled back, not committed: an appended event could never be
        // deleted afterwards, which would leave the seeded database changed.
        const appTrx = await appDb.transaction();
        const insert = await appTrx('booking_events')
          .insert({
            booking_id: fixture.booking.id,
            event_type: 'note',
            note: 'app role may append',
            actor_user_id: fixture.staff.id,
          })
          .then(() => null, (e) => e);
        await appTrx.rollback();
        assert.equal(insert, null, 'the app role must still be able to append');
      } finally {
        await appDb.destroy();
      }
    },
  );
});
