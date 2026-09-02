import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { BookingError } from '../src/domain/bookingErrors.js';
import { assertCancellable, assertSettleable } from '../src/domain/bookingTransitions.js';
import { assertCanCancel, assertCanCreate, assertCanSettle } from '../src/domain/bookingTiming.js';
import { isMembershipExpired } from '../src/domain/membership.js';
import { closeConnection, db } from '../src/db/knex.js';

/**
 * Phase P1 — pure booking domain rules, exercised with no HTTP server and no
 * transaction: every valid and invalid transition named in the brief,
 * the timing preconditions as pure functions of a boolean, the membership
 * predicate as a pure string comparison, and a live regression test proving
 * the `db/pgTypes.js` date-parser fix actually holds against PostgreSQL.
 */

describe('bookingTransitions — assertCancellable', () => {
  it('allows booked and waitlisted', () => {
    assert.doesNotThrow(() => assertCancellable('booked'));
    assert.doesNotThrow(() => assertCancellable('waitlisted'));
  });

  for (const status of ['cancelled', 'attended', 'no_show']) {
    it(`rejects cancelling a booking that is already ${status}, naming the current status`, () => {
      assert.throws(
        () => assertCancellable(status),
        (error) => {
          assert.ok(error instanceof BookingError);
          assert.equal(error.status, 409);
          assert.match(error.message, new RegExp(status));
          return true;
        },
      );
    });
  }
});

describe('bookingTransitions — assertSettleable', () => {
  it('allows booked -> attended and booked -> no_show', () => {
    assert.doesNotThrow(() => assertSettleable('booked', 'attended'));
    assert.doesNotThrow(() => assertSettleable('booked', 'no_show'));
  });

  it('rejects an invalid target status before checking current status', () => {
    assert.throws(
      () => assertSettleable('booked', 'cancelled'),
      (error) => {
        assert.ok(error instanceof BookingError);
        assert.equal(error.status, 400);
        return true;
      },
    );
  });

  for (const status of ['waitlisted', 'cancelled', 'attended', 'no_show']) {
    it(`rejects settling a booking that is currently ${status}, naming the current status`, () => {
      assert.throws(
        () => assertSettleable(status, 'attended'),
        (error) => {
          assert.ok(error instanceof BookingError);
          assert.equal(error.status, 409);
          assert.match(error.message, new RegExp(status));
          return true;
        },
      );
    });
  }

  it('rejects waitlisted -> no_show and attended -> no_show and no_show -> attended', () => {
    assert.throws(() => assertSettleable('waitlisted', 'no_show'), BookingError);
    assert.throws(() => assertSettleable('attended', 'no_show'), BookingError);
    assert.throws(() => assertSettleable('no_show', 'attended'), BookingError);
  });
});

describe('bookingTiming', () => {
  it('assertCanCreate rejects a started session and allows one that has not started', () => {
    assert.doesNotThrow(() => assertCanCreate({ hasStarted: false }));
    assert.throws(() => assertCanCreate({ hasStarted: true }), BookingError);
  });

  it('assertCanCancel rejects a started session and allows one that has not started', () => {
    assert.doesNotThrow(() => assertCanCancel({ hasStarted: false }));
    assert.throws(() => assertCanCancel({ hasStarted: true }), BookingError);
  });

  it('assertCanSettle rejects an unfinished session (before start or while running) and allows a finished one', () => {
    assert.doesNotThrow(() => assertCanSettle({ hasFinished: true }));
    assert.throws(() => assertCanSettle({ hasFinished: false }), BookingError);
  });
});

describe('membership — isMembershipExpired', () => {
  it('is not expired when the expiry date equals studio today', () => {
    assert.equal(isMembershipExpired('2026-09-02', '2026-09-02'), false);
  });

  it('is not expired when the expiry date is after studio today', () => {
    assert.equal(isMembershipExpired('2026-09-03', '2026-09-02'), false);
  });

  it('is expired when the expiry date is before studio today', () => {
    assert.equal(isMembershipExpired('2026-09-01', '2026-09-02'), true);
  });

  it('compares correctly across a month/year boundary', () => {
    assert.equal(isMembershipExpired('2025-12-31', '2026-01-01'), true);
    assert.equal(isMembershipExpired('2026-01-01', '2025-12-31'), false);
  });
});

describe('regression: PostgreSQL date columns round-trip as exact strings', () => {
  after(async () => {
    await closeConnection();
  });

  it('returns a date literal as an unshifted YYYY-MM-DD string, not a Date object', async () => {
    const { rows } = await db.raw(`SELECT '2027-01-01'::date AS d`);
    assert.equal(typeof rows[0].d, 'string');
    assert.equal(rows[0].d, '2027-01-01');
  });

  it('round-trips an inserted members.membership_expires_on unchanged', async () => {
    const [member] = await db('members')
      .insert({
        full_name: 'Booking Domain Date Regression',
        email: `booking-domain-date-regression-${Date.now()}@example.com`,
        membership_expires_on: '2027-06-15',
      })
      .returning('*');
    try {
      assert.equal(typeof member.membership_expires_on, 'string');
      assert.equal(member.membership_expires_on, '2027-06-15');

      const reread = await db('members').where({ id: member.id }).first();
      assert.equal(reread.membership_expires_on, '2027-06-15');
    } finally {
      await db('members').where({ id: member.id }).delete();
    }
  });
});
