import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { closeConnection, db } from '../src/db/knex.js';
import { isMembershipExpired } from '../src/domain/membership.js';
import { linkOrCreateMemberForSignup } from '../src/domain/memberLinking.js';
import { startTestServer } from './helpers/httpClient.js';

async function studioToday() {
  const { rows } = await db.raw(`SELECT to_char((now() AT TIME ZONE ?), 'YYYY-MM-DD') AS today`, [
    env.STUDIO_TIMEZONE,
  ]);
  return rows[0].today;
}

/**
 * `POST /api/auth/signup`'s account/member-linking behavior — a staff-created
 * `members` row should be claimed (via `members.user_id`, migration
 * `012_members_user_link.js`) by a later signup using the same email, never
 * duplicated, and never claimable by anyone else. See `docs/decisions.md`
 * for the linking rules this exercises and `domain/memberLinking.js` for the
 * implementation.
 */

let server;
const RUN = Date.now();
let counter = 0;
const createdUserEmails = [];

function uniqueEmail(prefix) {
  counter += 1;
  const email = `${prefix}-${RUN}-${counter}@example.test`;
  createdUserEmails.push(email);
  return email;
}

before(async () => {
  server = await startTestServer();
});

after(async () => {
  const users = await db('users').whereIn('email', createdUserEmails).select('id');
  const userIds = users.map((row) => row.id);
  if (userIds.length > 0) {
    // Members with a real booking attached (see the "preserves ... bookings"
    // test) are permanently undeletable by design (`bookings.member_id` is
    // ON DELETE RESTRICT) — the same "unique per run, never cleaned up"
    // pattern `tests/bookings.test.js` already uses for its own fixtures.
    // Every other member created here has no booking and is freely deleted.
    await db('members').whereIn('user_id', userIds).whereNotExists(function () {
      this.select('*').from('bookings').whereRaw('bookings.member_id = members.id');
    }).del();
  }
  await db('users').whereIn('email', createdUserEmails).del();
  await server.stop();
  await closeConnection();
});

describe('signup account/member linking', () => {
  it('links to an existing unlinked staff-created member by normalized email, and never duplicates it', async () => {
    const email = uniqueEmail('link');
    const [staffMember] = await db('members')
      .insert({ full_name: 'Staff Created Name', email, membership_expires_on: '2099-01-01' })
      .returning('*');

    const res = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'Signup Name', email, password: 'a-real-password-123' },
    });
    assert.equal(res.status, 201);

    const members = await db('members').where({ email });
    assert.equal(members.length, 1, 'no duplicate member row was created');
    assert.equal(String(members[0].id), String(staffMember.id));

    const user = await db('users').where({ email }).first();
    assert.equal(String(members[0].user_id), String(user.id));

    // Staff-maintained data is not overwritten by the signup form's own name.
    assert.equal(members[0].full_name, 'Staff Created Name');
  });

  it("preserves the existing member's bookings and membership expiry after linking", async () => {
    const email = uniqueEmail('link-bookings');
    const [staffMember] = await db('members')
      .insert({ full_name: 'Has Bookings', email, membership_expires_on: '2030-06-15' })
      .returning('*');

    const instructor = await db('users').where({ role: 'instructor', is_active: true }).first();
    const [room] = await db('rooms').insert({ name: `Link Test Room ${RUN}` }).returning('*');
    const [cls] = await db('classes')
      .insert({
        title: `Link Test Class ${RUN}`,
        discipline: 'Testing',
        default_duration_minutes: 60,
        default_capacity: 5,
      })
      .returning('*');
    const [session] = await db('sessions')
      .insert({
        class_id: cls.id,
        primary_instructor_id: instructor.id,
        room_id: room.id,
        starts_at: new Date(Date.now() + 24 * 3_600_000),
        duration_minutes: 60,
        capacity: 5,
      })
      .returning('*');
    const [booking] = await db('bookings')
      .insert({ session_id: session.id, member_id: staffMember.id, status: 'booked' })
      .returning('*');

    const res = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'Whatever Name The Form Had', email, password: 'a-real-password-123' },
    });
    assert.equal(res.status, 201);

    const stillThere = await db('bookings').where({ id: booking.id, member_id: staffMember.id });
    assert.equal(stillThere.length, 1, 'the existing booking is still attached to the same member row');

    const member = await db('members').where({ id: staffMember.id }).first();
    assert.equal(member.membership_expires_on, '2030-06-15');
    assert.equal(member.full_name, 'Has Bookings');
  });

  it('rejects a duplicate account, and never creates an orphan member when the signup itself fails', async () => {
    const email = uniqueEmail('dup');
    const first = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'First', email, password: 'a-real-password-123' },
    });
    assert.equal(first.status, 201);

    const firstUser = await db('users').where({ email }).first();
    const firstMembers = await db('members').where({ user_id: firstUser.id });
    assert.equal(firstMembers.length, 1, 'signup atomically produced exactly one linked member');

    const second = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'Second', email, password: 'a-different-password-456' },
    });
    assert.equal(second.status, 409);

    const users = await db('users').where({ email });
    assert.equal(users.length, 1, 'still exactly one user account');
    const members = await db('members').where({ email });
    assert.equal(members.length, 1, 'still exactly one member row');
  });

  it('normalizes email the same way for member matching (trim + case)', async () => {
    const base = uniqueEmail('case-link');
    const [staffMember] = await db('members')
      .insert({ full_name: 'Case Match', email: base, membership_expires_on: '2099-01-01' })
      .returning('*');

    const res = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'Case Signup', email: `  ${base.toUpperCase()}  `, password: 'a-real-password-123' },
    });
    assert.equal(res.status, 201);

    const members = await db('members').where({ email: base });
    assert.equal(members.length, 1);
    assert.equal(String(members[0].id), String(staffMember.id));
  });

  // A dedicated test for "more than one unlinked member shares this email"
  // (`linkOrCreateMemberForSignup`'s `candidates.length > 1` branch, which
  // creates a fresh member rather than guessing which candidate to link)
  // used to live here, constructed by directly inserting two `members` rows
  // with the same email. That scenario is no longer constructible at all —
  // `members_email_unique` (migration 014) now makes two members sharing an
  // email a database-level impossibility, a stronger guarantee than the
  // ambiguity-avoidance this test verified. The branch itself is left in
  // `memberLinking.js` unchanged (defensive code, not currently reachable in
  // ordinary operation — see that file's own comment) rather than removed,
  // per this milestone's explicit instruction not to change unrelated
  // signup/linking behavior. See `docs/decisions.md` for the full reasoning.

  it('cannot construct two unlinked members sharing an email in the first place — the database rejects it', async () => {
    const email = uniqueEmail('would-be-ambiguous');
    await db('members').insert({ full_name: 'Child A', email, membership_expires_on: '2099-01-01' });

    await assert.rejects(
      () => db('members').insert({ full_name: 'Child B', email, membership_expires_on: '2099-06-01' }),
      (error) => error.code === '23505',
      'a second member with the same normalized email must be rejected at the database layer',
    );

    const members = await db('members').where({ email });
    assert.equal(members.length, 1, 'only the first member exists — the rejected insert created nothing');
  });

  it('domain: a member already linked to a different user can never be claimed — excluded from candidates, and its link is untouched even when the fallback create collides', async () => {
    const email = uniqueEmail('domain-linked');
    const [existingUser] = await db('users')
      .insert({
        email: uniqueEmail('domain-owner'),
        full_name: 'Owner',
        password_hash: '$argon2id$fake',
        role: 'member',
      })
      .returning('*');
    const [linkedMember] = await db('members')
      .insert({ full_name: 'Linked', email, membership_expires_on: '2099-01-01', user_id: existingUser.id })
      .returning('*');

    const [newUser] = await db('users')
      .insert({
        email: uniqueEmail('domain-claimer'),
        full_name: 'Claimer',
        password_hash: '$argon2id$fake',
        role: 'member',
      })
      .returning('*');

    // This exact `email` is only reachable here because the test constructs
    // it directly — in real HTTP use, `email` is always the login the
    // caller just registered with, and `users.email` uniqueness already
    // guarantees no one else currently holds it (see `memberLinking.js`'s
    // own comment). With `members.email` now also unique
    // (migration 014), the already-linked candidate is still correctly
    // excluded (never claimed) — but the fallback "create a fresh member"
    // path then collides with that same member's own email, which the
    // database — correctly — refuses rather than silently double-using it.
    await assert.rejects(
      () => db.transaction((trx) => linkOrCreateMemberForSignup(trx, { userId: newUser.id, fullName: 'Claimer', email })),
      (error) => error.code === '23505',
    );

    // The one property this test exists to prove still holds: the
    // already-linked member was never reassigned to the new user.
    const stillLinked = await db('members').where({ id: linkedMember.id }).first();
    assert.equal(String(stillLinked.user_id), String(existingUser.id), "the original owner's link is untouched");
  });

  it('a brand-new signup with no matching member starts with an already-expired membership, not a free active one', async () => {
    const email = uniqueEmail('fresh');
    const res = await server.request({
      method: 'POST',
      path: '/api/auth/signup',
      body: { fullName: 'Fresh Signup', email, password: 'a-real-password-123' },
    });
    assert.equal(res.status, 201);

    const member = await db('members').where({ email }).first();
    const today = await studioToday();
    // Genuinely expired under the real, strict-`<` rule
    // (`domain/membership.js#isMembershipExpired`) — not merely "on or
    // before today", which an expiry of exactly today would also satisfy
    // while still being bookable for the rest of that civil day.
    assert.equal(
      isMembershipExpired(member.membership_expires_on, today),
      true,
      'a self-registered member has no bookable membership yet',
    );
  });
});
