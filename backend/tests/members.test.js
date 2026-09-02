import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { startTestServer } from './helpers/httpClient.js';

/**
 * Goal 1 — "studio staff ... add members and set their membership expiry":
 * `POST /api/members` and `PATCH /api/members/:id`, exercised over real HTTP
 * against a running app and a live database.
 *
 * A member with no bookings has no incoming `RESTRICT` foreign key (only
 * `bookings.member_id` and the `CASCADE`d `member_alert_dismissals`), so
 * every fixture here is freely deletable and cleaned up in `after()` —
 * unlike most of this project's other test files, whose booking-carrying
 * fixtures are permanent by design.
 */

let server;
const RUN = Date.now();
const fixture = {};
const createdMemberIds = [];
let counter = 0;

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

function validMemberBody(overrides = {}) {
  counter += 1;
  return {
    fullName: `Members Test Fixture ${RUN}-${counter}`,
    email: `members-test-${RUN}-${counter}@example.com`,
    membershipExpiresOn: '2099-01-01',
    ...overrides,
  };
}

async function createMember(cookie, overrides = {}) {
  const res = await server.request({
    method: 'POST',
    path: '/api/members',
    cookie,
    body: validMemberBody(overrides),
  });
  assert.equal(res.status, 201, `member fixture creation must succeed: ${res.raw}`);
  createdMemberIds.push(res.json.member.id);
  return res.json.member;
}

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

describe('POST /api/members', () => {
  it('lets staff create a member', async () => {
    const cookie = await loginAs(fixture.staff);
    const body = validMemberBody();
    const res = await server.request({ method: 'POST', path: '/api/members', cookie, body });
    assert.equal(res.status, 201, res.raw);
    createdMemberIds.push(res.json.member.id);
    assert.equal(res.json.member.fullName, body.fullName);
    assert.equal(res.json.member.email, body.email);
    assert.equal(res.json.member.membershipExpiresOn, body.membershipExpiresOn);
    assert.match(res.json.member.id, /^[1-9][0-9]*$/, 'id must be a bigint string');
  });

  it('normalizes email to lowercase and trimmed', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'POST',
      path: '/api/members',
      cookie,
      body: validMemberBody({ email: '  Mixed.Case@Example.COM  ' }),
    });
    assert.equal(res.status, 201, res.raw);
    createdMemberIds.push(res.json.member.id);
    assert.equal(res.json.member.email, 'mixed.case@example.com');
  });

  it('allows two members to share an email address (deliberately non-unique)', async () => {
    const cookie = await loginAs(fixture.staff);
    const sharedEmail = `shared-${RUN}@example.com`;
    const first = await createMember(cookie, { email: sharedEmail });
    const second = await createMember(cookie, { email: sharedEmail });
    assert.equal(first.email, sharedEmail);
    assert.equal(second.email, sharedEmail);
    assert.notEqual(first.id, second.id);
  });

  it('denies an instructor', async () => {
    const cookie = await loginAs(fixture.instructor);
    const res = await server.request({
      method: 'POST',
      path: '/api/members',
      cookie,
      body: validMemberBody(),
    });
    assert.equal(res.status, 403);
  });

  it('denies an unauthenticated request', async () => {
    const res = await server.request({
      method: 'POST',
      path: '/api/members',
      body: validMemberBody(),
    });
    assert.equal(res.status, 401);
  });

  describe('validation', () => {
    it('rejects a missing fullName', async () => {
      const cookie = await loginAs(fixture.staff);
      const body = validMemberBody();
      delete body.fullName;
      const res = await server.request({ method: 'POST', path: '/api/members', cookie, body });
      assert.equal(res.status, 400);
    });

    it('rejects a blank fullName', async () => {
      const cookie = await loginAs(fixture.staff);
      const res = await server.request({
        method: 'POST',
        path: '/api/members',
        cookie,
        body: validMemberBody({ fullName: '   ' }),
      });
      assert.equal(res.status, 400);
    });

    it('rejects a malformed email', async () => {
      const cookie = await loginAs(fixture.staff);
      const res = await server.request({
        method: 'POST',
        path: '/api/members',
        cookie,
        body: validMemberBody({ email: 'not-an-email' }),
      });
      assert.equal(res.status, 400);
    });

    it('rejects a missing membershipExpiresOn', async () => {
      const cookie = await loginAs(fixture.staff);
      const body = validMemberBody();
      delete body.membershipExpiresOn;
      const res = await server.request({ method: 'POST', path: '/api/members', cookie, body });
      assert.equal(res.status, 400);
    });

    it('rejects a malformed membershipExpiresOn', async () => {
      const cookie = await loginAs(fixture.staff);
      const res = await server.request({
        method: 'POST',
        path: '/api/members',
        cookie,
        body: validMemberBody({ membershipExpiresOn: '01/01/2099' }),
      });
      assert.equal(res.status, 400);
    });
  });
});

describe('PATCH /api/members/:id', () => {
  it('lets staff update a member\'s membership expiry date', async () => {
    const cookie = await loginAs(fixture.staff);
    const member = await createMember(cookie);
    const res = await server.request({
      method: 'PATCH',
      path: `/api/members/${member.id}`,
      cookie,
      body: { membershipExpiresOn: '2026-09-10' },
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.member.membershipExpiresOn, '2026-09-10');
    assert.equal(res.json.member.fullName, member.fullName, 'other fields must be unchanged');
  });

  it('lets staff update fullName and email independently', async () => {
    const cookie = await loginAs(fixture.staff);
    const member = await createMember(cookie);
    const res = await server.request({
      method: 'PATCH',
      path: `/api/members/${member.id}`,
      cookie,
      body: { fullName: 'Renamed Member', email: 'renamed@example.com' },
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.member.fullName, 'Renamed Member');
    assert.equal(res.json.member.email, 'renamed@example.com');
    assert.equal(res.json.member.membershipExpiresOn, member.membershipExpiresOn);
  });

  it('moving the expiry into the alert window makes the member appear in goal 10\'s alert list', async () => {
    const cookie = await loginAs(fixture.staff);
    const member = await createMember(cookie);

    const { rows } = await db.raw(
      `SELECT to_char((now() AT TIME ZONE ?), 'YYYY-MM-DD') AS today`,
      [env.STUDIO_TIMEZONE],
    );
    const [y, m, d] = rows[0].today.split('-').map(Number);
    const inTwoDays = new Date(Date.UTC(y, m - 1, d + 2)).toISOString().slice(0, 10);

    const patchRes = await server.request({
      method: 'PATCH',
      path: `/api/members/${member.id}`,
      cookie,
      body: { membershipExpiresOn: inTwoDays },
    });
    assert.equal(patchRes.status, 200, patchRes.raw);

    const alertsRes = await server.request({
      method: 'GET',
      path: '/api/members/alerts/expiring',
      cookie,
    });
    assert.equal(alertsRes.status, 200, alertsRes.raw);
    assert.ok(
      alertsRes.json.alerts.some((a) => a.memberId === String(member.id)),
      'a member just moved into the seven-day window must appear in the alert list',
    );
  });

  it('denies an instructor', async () => {
    const cookie = await loginAs(fixture.staff);
    const member = await createMember(cookie);
    const instructorCookie = await loginAs(fixture.instructor);
    const res = await server.request({
      method: 'PATCH',
      path: `/api/members/${member.id}`,
      cookie: instructorCookie,
      body: { fullName: 'Should Not Apply' },
    });
    assert.equal(res.status, 403);
  });

  it('denies an unauthenticated request', async () => {
    const cookie = await loginAs(fixture.staff);
    const member = await createMember(cookie);
    const res = await server.request({
      method: 'PATCH',
      path: `/api/members/${member.id}`,
      body: { fullName: 'Should Not Apply' },
    });
    assert.equal(res.status, 401);
  });

  it('404s for a member id that does not exist', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'PATCH',
      path: '/api/members/999999999',
      cookie,
      body: { fullName: 'Ghost' },
    });
    assert.equal(res.status, 404);
  });

  it('400s for a malformed member id', async () => {
    const cookie = await loginAs(fixture.staff);
    const res = await server.request({
      method: 'PATCH',
      path: '/api/members/not-an-id',
      cookie,
      body: { fullName: 'Ghost' },
    });
    assert.equal(res.status, 400);
  });

  it('400s when no fields are provided', async () => {
    const cookie = await loginAs(fixture.staff);
    const member = await createMember(cookie);
    const res = await server.request({
      method: 'PATCH',
      path: `/api/members/${member.id}`,
      cookie,
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('400s for a malformed email or membershipExpiresOn on update', async () => {
    const cookie = await loginAs(fixture.staff);
    const member = await createMember(cookie);

    const badEmail = await server.request({
      method: 'PATCH',
      path: `/api/members/${member.id}`,
      cookie,
      body: { email: 'not-an-email' },
    });
    assert.equal(badEmail.status, 400);

    const badDate = await server.request({
      method: 'PATCH',
      path: `/api/members/${member.id}`,
      cookie,
      body: { membershipExpiresOn: 'not-a-date' },
    });
    assert.equal(badDate.status, 400);
  });
});
