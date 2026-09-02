import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  expandCandidateDates,
  formatDateStr,
  localTimestampString,
} from '../src/domain/recurringSchedule.js';

/**
 * Goal 7 — pure calendar-date expansion, unit-tested with no database and no
 * timezone dependency: this module never converts a local time to an
 * instant itself (see the module's own comment for why), so there is
 * nothing timezone-sensitive to unit-test here. DST correctness is verified
 * where it actually happens — against real PostgreSQL — in
 * `tests/recurringSessions.test.js`.
 */

describe('formatDateStr', () => {
  it('zero-pads month and day', () => {
    assert.equal(formatDateStr(2026, 3, 7), '2026-03-07');
    assert.equal(formatDateStr(2026, 12, 31), '2026-12-31');
  });
});

describe('localTimestampString', () => {
  it('appends seconds to a local HH:MM time', () => {
    assert.equal(localTimestampString('2026-03-07', '09:00'), '2026-03-07 09:00:00');
  });
});

describe('expandCandidateDates', () => {
  it('includes both the start and end date when they match a requested weekday', () => {
    // 2026-03-02 is a Monday, 2026-03-09 is the following Monday.
    const dates = expandCandidateDates({
      startDate: '2026-03-02',
      endDate: '2026-03-09',
      weekdays: [1], // Monday
    });
    assert.deepEqual(dates, ['2026-03-02', '2026-03-09']);
  });

  it('returns dates in chronological order for a multi-weekday pattern', () => {
    // 2026-03-02 is a Monday; Mon/Wed/Fri across two weeks.
    const dates = expandCandidateDates({
      startDate: '2026-03-02',
      endDate: '2026-03-13',
      weekdays: [1, 3, 5],
    });
    assert.deepEqual(dates, [
      '2026-03-02', // Mon
      '2026-03-04', // Wed
      '2026-03-06', // Fri
      '2026-03-09', // Mon
      '2026-03-11', // Wed
      '2026-03-13', // Fri
    ]);
  });

  it('returns an empty list when no date in range matches any requested weekday', () => {
    // 2026-03-02..2026-03-08 is exactly one week; Sunday-only over a range
    // that starts on Monday and ends on Sunday still includes exactly one
    // Sunday, so use a range that excludes Sunday entirely to prove emptiness.
    const dates = expandCandidateDates({
      startDate: '2026-03-02', // Monday
      endDate: '2026-03-07', // Saturday
      weekdays: [0], // Sunday
    });
    assert.deepEqual(dates, []);
  });

  it('deduplicates a weekday supplied more than once', () => {
    const dates = expandCandidateDates({
      startDate: '2026-03-02',
      endDate: '2026-03-02',
      weekdays: [1, 1, 1],
    });
    assert.deepEqual(dates, ['2026-03-02']);
  });

  it('handles a single-day range', () => {
    const matching = expandCandidateDates({
      startDate: '2026-03-02',
      endDate: '2026-03-02',
      weekdays: [1],
    });
    assert.deepEqual(matching, ['2026-03-02']);

    const nonMatching = expandCandidateDates({
      startDate: '2026-03-02',
      endDate: '2026-03-02',
      weekdays: [2],
    });
    assert.deepEqual(nonMatching, []);
  });

  it('handles a range spanning a month/year boundary', () => {
    // 2025-12-29 is a Monday; the next two Mondays cross into January 2026.
    const dates = expandCandidateDates({
      startDate: '2025-12-29',
      endDate: '2026-01-12',
      weekdays: [1],
    });
    assert.deepEqual(dates, ['2025-12-29', '2026-01-05', '2026-01-12']);
  });
});
