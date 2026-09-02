import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Goal 10 — `GET /api/members/alerts/expiring` and
 * `POST /api/members/:memberId/alerts/membership-expiry/dismiss`, exercised
 * over real HTTP against a running app and a live database.
 *
 * The alert list is studio-wide, like the dashboard (goal 8) — the seed
 * itself creates members inside the alert window (see
 * `seeds/001_demo_data.js`), and other suites' leftover permanent fixtures
 * (`bookings.test.js` et al.) include members with near-today expiry dates
 * of their own, created to exercise the "expired membership can't book"
 * rule. Every assertion below therefore checks for the presence or absence
 * of one specific, freshly-created member id in the response, never the
 * response's overall size or contents.
 *
 * Unlike every session/booking fixture elsewhere in this suite, a member
 * with no bookings is freely deletable (`members` has no `RESTRICT` FK
 * pointing at it except `bookings.member_id`, and
 * `member_alert_dismissals.member_id` cascades) — so, unusually for this
 * project's test suite, fixtures here are cleaned up in `after()` rather
 * than left permanently.
 */

let server;
const RUN = Date.now();
const createdMemberIds = [];
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

/** Ground truth for "studio-local today", sourced from PostgreSQL exactly
 * the way `bookings.test.js#studioToday` already does — not a re-derivation
 * of the endpoint's own logic. */
async function studioToday() {
  const { rows } = await db.raw(
    `SELECT to_char((now() AT TIME ZONE ?), 'YYYY-MM-DD') AS today`,
    [env.STUDIO_TIMEZONE],
  );
  return rows[0].today;
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

async function createMember(expiresOn) {
  memberCounter += 1;
  const [member] = await db('members')
    .insert({
      full_name: `Membership Alert Test Member ${RUN}-${memberCounter}`,
      email: `membership-alert-test-${RUN}-${memberCounter}@example.com`,
      membership_expires_on: expiresOn,
    })
    .returning('*');
  createdMemberIds.push(member.id);
  return member;
}

async function setExpiry(memberId, expiresOn) {
  await db('members').where({ id: memberId }).update({ membership_expires_on: expiresOn });
}

async function fetchAlerts(cookie) {
  const res = await server.request({ method: 'GET', path: '/api/members/alerts/expiring', cookie });
  assert.equal(res.status, 200, res.raw);
  assert.ok(Array.isArray(res.json.alerts), 'alerts must always be an array');
  return res.json.alerts;
}

function findAlert(alerts, memberId) {
  return alerts.find((a) => a.memberId === String(memberId));
}

function dismiss(cookie, memberId, body) {
  return server.request({
    method: 'POST',
    path: `/api/members/${memberId}/alerts/membership-expiry/dismiss`,
    cookie,
    body,
  });
}

async function dismissalCount(memberId, expiresOn) {
  const [{ count }] = await db('member_alert_dismissals')
    .where({ member_id: memberId, dismissed_expiry_date: expiresOn })
    .count({ count: '*' });
  return Number(count);
}

const fixture = {};

before(async () => {
  server = await startTestServer();
  fixture.staff = await db('users').where({ role: 'staff', is_active: true }).first();
  fixture.instructor = await db('users').where({ role: 'instructor', is_active: true }).first();
});

after(async () => {
  if (createdMemberIds.length > 0) {
    await db('members').whereIn('id', createdMemberIds).delete();
  }
  await server.stop();
  await closeConnection();
});

describe('GET /api/members/alerts/expiring — authorization', () => {
  it('lets staff list alerts', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({ method: 'GET', path: '/api/members/alerts/expiring', cookie });
    assert.equal(res.status, 200, res.raw);
  });

  it('denies an instructor', async () => {
    const cookie = await loginAs(fixture.instructor);
    const res = await server.request({ method: 'GET', path: '/api/members/alerts/expiring', cookie });
    assert.equal(res.status, 403);
  });

  it('denies an unauthenticated request', async () => {
    const res = await server.request({ method: 'GET', path: '/api/members/alerts/expiring' });
    assert.equal(res.status, 401);
  });

  it('cannot be bypassed by an instructor spoofing a staff role via query parameter', async () => {
    const cookie = await loginAs(fixture.instructor);
    const res = await server.request({
      method: 'GET',
      path: '/api/members/alerts/expiring?role=staff',
      cookie,
    });
    assert.equal(res.status, 403);
  });
});

describe('POST /:memberId/alerts/membership-expiry/dismiss — authorization', () => {
  it('denies an instructor', async () => {
    const today = await studioToday();
    const member = await createMember(addDays(today, 2));
    const cookie = await loginAs(fixture.instructor);
    const res = await dismiss(cookie, member.id);
    assert.equal(res.status, 403);
  });

  it('denies an unauthenticated request', async () => {
    const today = await studioToday();
    const member = await createMember(addDays(today, 2));
    const res = await server.request({
      method: 'POST',
      path: `/api/members/${member.id}/alerts/membership-expiry/dismiss`,
    });
    assert.equal(res.status, 401);
  });

  it('404s for a member id that does not exist', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await dismiss(cookie, '999999999');
    assert.equal(res.status, 404);
  });

  it('400s for a malformed member id', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await dismiss(cookie, 'not-an-id');
    assert.equal(res.status, 400);
  });
});

describe('alert predicate — window boundaries', () => {
  it('alerts an expired membership, with isExpired true and a negative daysUntilExpiry', async () => {
    const today = await studioToday();
    const member = await createMember(addDays(today, -30));
    const cookie = await loginAs(fixture.staff);
    const alert = findAlert(await fetchAlerts(cookie), member.id);
    assert.ok(alert, 'an expired membership must alert');
    assert.equal(alert.isExpired, true);
    assert.equal(alert.daysUntilExpiry, -30);
  });

  it('alerts a membership expiring today, with isExpired false (still valid through the civil day)', async () => {
    const today = await studioToday();
    const member = await createMember(today);
    const cookie = await loginAs(fixture.staff);
    const alert = findAlert(await fetchAlerts(cookie), member.id);
    assert.ok(alert, 'a membership expiring today must alert');
    assert.equal(alert.isExpired, false);
    assert.equal(alert.daysUntilExpiry, 0);
  });

  it('alerts a membership expiring in 1 day', async () => {
    const today = await studioToday();
    const member = await createMember(addDays(today, 1));
    const cookie = await loginAs(fixture.staff);
    const alert = findAlert(await fetchAlerts(cookie), member.id);
    assert.ok(alert);
    assert.equal(alert.daysUntilExpiry, 1);
  });

  it('alerts a membership expiring in exactly 7 days (inclusive boundary)', async () => {
    const today = await studioToday();
    const member = await createMember(addDays(today, 7));
    const cookie = await loginAs(fixture.staff);
    const alert = findAlert(await fetchAlerts(cookie), member.id);
    assert.ok(alert, 'exactly 7 days out must still alert');
    assert.equal(alert.daysUntilExpiry, 7);
  });

  it('does not alert a membership expiring in 8 days (exclusive boundary)', async () => {
    const today = await studioToday();
    const member = await createMember(addDays(today, 8));
    const cookie = await loginAs(fixture.staff);
    const alert = findAlert(await fetchAlerts(cookie), member.id);
    assert.equal(alert, undefined, '8 days out must not alert');
  });

  it('does not alert a membership well outside the window', async () => {
    const today = await studioToday();
    const member = await createMember(addDays(today, 365));
    const cookie = await loginAs(fixture.staff);
    const alert = findAlert(await fetchAlerts(cookie), member.id);
    assert.equal(alert, undefined);
  });

  it('computes daysUntilExpiry using the studio-local civil date, not the server process clock', async () => {
    const today = await studioToday();
    const member = await createMember(addDays(today, 4));
    const cookie = await loginAs(fixture.staff);
    const alert = findAlert(await fetchAlerts(cookie), member.id);
    assert.ok(alert);
    assert.equal(alert.daysUntilExpiry, 4, 'must be exactly 4, not off by one across a timezone boundary');
    assert.equal(alert.isExpired, false);
  });
});

describe('dismissal', () => {
  it('removes the alert once dismissed, and the dismissal is idempotent with exactly one row', async () => {
    const today = await studioToday();
    const expiresOn = addDays(today, 3);
    const member = await createMember(expiresOn);
    const cookie = await loginAs(fixture.staff);

    assert.ok(findAlert(await fetchAlerts(cookie), member.id), 'must alert before dismissal');

    const first = await dismiss(cookie, member.id);
    assert.equal(first.status, 200, first.raw);
    assert.equal(first.json.dismissal.memberId, String(member.id));
    assert.equal(first.json.dismissal.dismissedExpiryDate, expiresOn);

    assert.equal(findAlert(await fetchAlerts(cookie), member.id), undefined, 'must not alert after dismissal');

    const second = await dismiss(cookie, member.id);
    assert.equal(second.status, 200, second.raw);
    assert.equal(
      second.json.dismissal.dismissedAt,
      first.json.dismissal.dismissedAt,
      'a repeated dismissal must return the original dismissal, not create a new one',
    );

    assert.equal(
      await dismissalCount(member.id, expiresOn),
      1,
      'exactly one dismissal row must exist regardless of how many times dismiss was called',
    );
  });

  it('rejects dismissing a member who is not currently within the alert window, and inserts nothing', async () => {
    const today = await studioToday();
    const expiresOn = addDays(today, 30);
    const member = await createMember(expiresOn);
    const cookie = await loginAs(fixture.staff);

    const res = await dismiss(cookie, member.id);
    assert.equal(res.status, 409, res.raw);
    assert.equal(await dismissalCount(member.id, expiresOn), 0);
  });

  it('brings the alert back when the expiry changes to a different in-window date, and re-suppresses it when changed back to the exact dismissed date', async () => {
    const today = await studioToday();
    const firstExpiry = addDays(today, 2);
    const secondExpiry = addDays(today, 5);
    const member = await createMember(firstExpiry);
    const cookie = await loginAs(fixture.staff);

    // Dismiss at the first expiry date.
    const dismissRes = await dismiss(cookie, member.id);
    assert.equal(dismissRes.status, 200, dismissRes.raw);
    assert.equal(findAlert(await fetchAlerts(cookie), member.id), undefined);

    // Staff moves the expiry to a different, still-in-window date: the old
    // dismissal was keyed to the old date, so it no longer applies.
    await setExpiry(member.id, secondExpiry);
    const afterChange = findAlert(await fetchAlerts(cookie), member.id);
    assert.ok(afterChange, 'the alert must return once the expiry moves to a new, undismissed date');
    assert.equal(afterChange.membershipExpiresOn, secondExpiry);

    // Moving it back to the exact date that was dismissed before suppresses
    // it again — the dismissal row for that exact (member, date) pair was
    // never deleted, only stopped matching while the expiry was different.
    await setExpiry(member.id, firstExpiry);
    assert.equal(
      findAlert(await fetchAlerts(cookie), member.id),
      undefined,
      'moving the expiry back to the previously-dismissed date must suppress the alert again',
    );
  });

  it('removes the alert when the expiry changes to a non-alerting date, with no dismissal involved', async () => {
    const today = await studioToday();
    const member = await createMember(addDays(today, 3));
    const cookie = await loginAs(fixture.staff);
    assert.ok(findAlert(await fetchAlerts(cookie), member.id));

    await setExpiry(member.id, addDays(today, 365));
    assert.equal(findAlert(await fetchAlerts(cookie), member.id), undefined);
  });

  it('keeps an expired member suppressed across repeated reads once dismissed, until the expiry changes', async () => {
    const today = await studioToday();
    const expiresOn = addDays(today, -5);
    const member = await createMember(expiresOn);
    const cookie = await loginAs(fixture.staff);

    assert.ok(findAlert(await fetchAlerts(cookie), member.id), 'an expired member must alert before dismissal');
    const dismissRes = await dismiss(cookie, member.id);
    assert.equal(dismissRes.status, 200, dismissRes.raw);

    assert.equal(findAlert(await fetchAlerts(cookie), member.id), undefined);
    // A second, independent read — nothing about reading should un-suppress it.
    assert.equal(findAlert(await fetchAlerts(cookie), member.id), undefined);
  });

  it('ignores a spoofed memberId in the request body — the URL param is the only member ever affected', async () => {
    const today = await studioToday();
    const memberA = await createMember(addDays(today, 2));
    const memberB = await createMember(addDays(today, 3));
    const cookie = await loginAs(fixture.staff);

    const res = await dismiss(cookie, memberA.id, { memberId: String(memberB.id) });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.dismissal.memberId, String(memberA.id));

    const alerts = await fetchAlerts(cookie);
    assert.equal(findAlert(alerts, memberA.id), undefined, 'only memberA (the URL param) must be dismissed');
    assert.ok(findAlert(alerts, memberB.id), 'memberB must be untouched');
  });

  it('does not itself create or change any dismissal row when only reading', async () => {
    const cookie = await loginAs(fixture.staff);

    const before = await db('member_alert_dismissals').count({ count: '*' }).first();
    await fetchAlerts(cookie);
    await fetchAlerts(cookie);
    const after = await db('member_alert_dismissals').count({ count: '*' }).first();

    assert.equal(Number(after.count), Number(before.count), 'GET must never write a dismissal row');
  });
});
