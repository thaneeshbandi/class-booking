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

  // `members.email` was, until migration 014, deliberately non-unique (one
  // parent's email on two children's memberships was considered ordinary —
  // see `003_members.js`). That was reversed on an explicit product
  // requirement: staff must not be able to create two members sharing an
  // email. See `docs/decisions.md` for the full reasoning. The tests below
  // replace the one that used to prove the opposite of this.
  it('rejects creating a member with an email that already exists', async () => {
    const cookie = await loginAs(fixture.staff);
    const email = `duplicate-${RUN}-${counter}@example.com`;
    const original = await createMember(cookie, { email });

    const res = await server.request({
      method: 'POST',
      path: '/api/members',
      cookie,
      body: validMemberBody({ email }),
    });
    assert.equal(res.status, 409, res.raw);
    assert.equal(res.json.error, 'A member with this email already exists.');
    assert.doesNotMatch(res.raw, /SQLSTATE|duplicate key value|constraint/i, 'never a raw database error');

    // The original member is completely untouched by the rejected attempt.
    const stillThere = await db('members').where({ id: original.id }).first();
    assert.equal(stillThere.full_name, original.fullName);
    assert.equal(stillThere.email, email);
    const matches = await db('members').where({ email });
    assert.equal(matches.length, 1, 'no duplicate row was created');
  });

  it('duplicate detection is case-insensitive and ignores surrounding whitespace', async () => {
    const cookie = await loginAs(fixture.staff);
    const email = `case-check-${RUN}-${counter}@example.com`;
    await createMember(cookie, { email });

    const res = await server.request({
      method: 'POST',
      path: '/api/members',
      cookie,
      body: validMemberBody({ email: `  ${email.toUpperCase()}  ` }),
    });
    assert.equal(res.status, 409, res.raw);
    assert.equal(res.json.error, 'A member with this email already exists.');
  });

  it('two concurrent creates for the same email: exactly one succeeds, the other gets a clean 409', async () => {
    const cookie = await loginAs(fixture.staff);
    const email = `concurrent-${RUN}-${counter}@example.com`;
    const body = validMemberBody({ email });

    const [first, second] = await Promise.all([
      server.request({ method: 'POST', path: '/api/members', cookie, body }),
      server.request({ method: 'POST', path: '/api/members', cookie, body: { ...body, fullName: body.fullName + ' (2)' } }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409], 'exactly one create succeeds and the other conflicts');
    const succeeded = first.status === 201 ? first : second;
    createdMemberIds.push(succeeded.json.member.id);

    const rows = await db('members').where({ email });
    assert.equal(rows.length, 1, 'the database itself has exactly one row for this email, not a race-created duplicate');
  });

  it('the database constraint itself rejects a duplicate email, independent of the API layer', async () => {
    const email = `direct-insert-${RUN}-${counter}@example.com`;
    const [inserted] = await db('members')
      .insert({ full_name: 'Direct Insert', email, membership_expires_on: '2099-01-01' })
      .returning('id');
    createdMemberIds.push(inserted.id);

    await assert.rejects(
      () => db('members').insert({ full_name: 'Direct Insert Duplicate', email, membership_expires_on: '2099-01-01' }),
      (error) => error.code === '23505' && error.constraint === 'members_email_unique',
    );
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

  it('rejects updating a member to another member\'s email', async () => {
    const cookie = await loginAs(fixture.staff);
    const other = await createMember(cookie);
    const target = await createMember(cookie);

    const res = await server.request({
      method: 'PATCH',
      path: `/api/members/${target.id}`,
      cookie,
      body: { email: other.email },
    });
    assert.equal(res.status, 409, res.raw);
    assert.equal(res.json.error, 'A member with this email already exists.');
    assert.doesNotMatch(res.raw, /SQLSTATE|duplicate key value|constraint/i, 'never a raw database error');

    // Neither member was changed by the rejected attempt.
    const targetRow = await db('members').where({ id: target.id }).first();
    const otherRow = await db('members').where({ id: other.id }).first();
    assert.equal(targetRow.email, target.email);
    assert.equal(otherRow.email, other.email);
  });

  it('allows updating a member to their own current email (including a re-normalized form of it)', async () => {
    const cookie = await loginAs(fixture.staff);
    const member = await createMember(cookie);

    const res = await server.request({
      method: 'PATCH',
      path: `/api/members/${member.id}`,
      cookie,
      body: { email: `  ${member.email.toUpperCase()}  `, fullName: 'Same Email, New Name' },
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.member.email, member.email);
    assert.equal(res.json.member.fullName, 'Same Email, New Name');
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
