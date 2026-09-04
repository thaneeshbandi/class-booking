import { expect, test } from '@playwright/test';

import {
  INSTRUCTOR,
  SEED_ROOM_NAME,
  STAFF,
  attachDiagnostics,
  login,
  logout,
  randomFutureDayOffset,
  uniqueLabel,
} from './fixtures.js';

function isoDate(daysFromNow) {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

function toDatetimeLocalValue(daysFromNow) {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  d.setHours(9, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

async function signup(page, { fullName, email, password = 'a-real-password-123' }) {
  await page.goto('/signup');
  await page.getByLabel('Full name').fill(fullName);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForURL(/\/member$/);
}

// One continuous journey: staff creates a member record with a real
// membership and a bookable session, that member self-registers with the
// same email (must be *linked*, not duplicated), then uses the full member
// portal — browse, book, view, cancel, edit profile, change password.
test.describe.serial('member portal — account linking, browsing, booking, cancellation', () => {
  let page;
  let diag;
  const memberName = uniqueLabel('Portal Member');
  const memberEmail = `portal-member-${Date.now()}@example.com`;
  const className = uniqueLabel('Portal Class');
  const sessionDayOffset = randomFutureDayOffset();

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    diag = attachDiagnostics(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('staff creates a member (with a real membership expiry) and a bookable session', async () => {
    await login(page, STAFF);

    await page.getByRole('link', { name: 'Members' }).click();
    await page.getByRole('button', { name: 'Add member' }).click();
    const memberDialog = page.getByRole('dialog');
    await memberDialog.getByLabel('Full name').fill(memberName);
    await memberDialog.getByLabel('Email').fill(memberEmail);
    await memberDialog.getByLabel('Membership expires on').fill(isoDate(180));
    await memberDialog.getByRole('button', { name: 'Add member', exact: true }).click();
    await expect(memberDialog).not.toBeVisible();

    await page.getByRole('link', { name: 'Classes' }).click();
    await page.getByRole('button', { name: 'Create class' }).click();
    const classDialog = page.getByRole('dialog');
    await classDialog.getByLabel('Title').fill(className);
    await classDialog.getByLabel('Discipline').fill('Portal Testing');
    await classDialog.getByLabel('Default duration (minutes)').fill('45');
    await classDialog.getByLabel('Default capacity').fill('2');
    await classDialog.getByRole('button', { name: 'Create class', exact: true }).click();
    await expect(classDialog).not.toBeVisible();

    await page.getByRole('link', { name: 'Sessions', exact: true }).click();
    await page.getByRole('button', { name: 'Create session' }).click();
    const sessionDialog = page.getByRole('dialog');
    await sessionDialog.getByLabel('Class', { exact: true }).selectOption({ label: className });
    await sessionDialog.getByLabel('Primary instructor').selectOption({ label: INSTRUCTOR.fullName });
    await sessionDialog.getByLabel('Room').selectOption({ label: SEED_ROOM_NAME });
    await sessionDialog.getByLabel('Starts at (your local time)').fill(toDatetimeLocalValue(sessionDayOffset));
    await sessionDialog.getByRole('button', { name: 'Create session', exact: true }).click();
    await expect(sessionDialog).not.toBeVisible();

    await logout(page);
  });

  test('signing up with the staff-created member\'s email claims that member — membership expiry carries over, not a fresh signup default', async () => {
    await signup(page, { fullName: 'Different Signup Name', email: memberEmail });
    await expect(page).toHaveURL(/\/member$/);
    // ~6 months out is "Active", never the "Expired" a brand-new,
    // unlinked signup would start with (see docs/decisions.md).
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
  });

  test('browses sessions and books the one staff created', async () => {
    await page.getByRole('link', { name: 'Sessions', exact: true }).click();
    await expect(page).toHaveURL(/\/member\/sessions$/);

    const card = page.locator('.member-session-card').filter({ hasText: className });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /^book$/i }).click();
    await expect(card.getByText('Booked', { exact: true })).toBeVisible();
  });

  test('the booking appears in "My bookings", and nowhere else', async () => {
    await page.locator('nav.sidebar-nav').getByRole('link', { name: 'My Bookings' }).click();
    await expect(page).toHaveURL(/\/member\/bookings$/);

    const row = page.getByRole('row', { name: new RegExp(className) });
    await expect(row).toBeVisible();
    await expect(row.getByText('Booked', { exact: true })).toBeVisible();
  });

  test('the upcoming booking also shows on the member home page', async () => {
    await page.getByRole('link', { name: 'Home' }).click();
    await expect(page).toHaveURL(/\/member$/);
    await expect(page.getByText(className)).toBeVisible();
  });

  test('cancels the booking, reusing the same lifecycle rules staff bookings use', async () => {
    await page.locator('nav.sidebar-nav').getByRole('link', { name: 'My Bookings' }).click();
    const row = page.getByRole('row', { name: new RegExp(className) });
    await row.getByRole('button', { name: 'Cancel' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /cancel booking/i }).click();

    await expect(row.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  });

  test('member home reflects the cancellation — no upcoming bookings', async () => {
    await page.getByRole('link', { name: 'Home' }).click();
    await expect(page.getByText('No upcoming bookings yet.')).toBeVisible();
  });

  test('edits full name on the profile page — reflected immediately in the topbar', async () => {
    await page.locator('nav.sidebar-nav').getByRole('link', { name: 'Profile' }).click();
    await expect(page).toHaveURL(/\/profile$/);

    await page.getByLabel('Full name').fill('Updated Portal Name');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Your name has been updated.')).toBeVisible();
    await expect(page.locator('.topbar-user-text .user-name')).toHaveText('Updated Portal Name');

    // Email is genuinely read-only — no input to even attempt editing it.
    await expect(page.getByLabel('Email')).toBeDisabled();
  });

  test('changes password on the profile page, then logs in with the new one', async () => {
    await page.getByLabel('Current password').fill('a-real-password-123');
    await page.getByLabel('New password', { exact: true }).fill('a-brand-new-password-456');
    await page.getByLabel('Confirm new password').fill('a-brand-new-password-456');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Your password has been changed.')).toBeVisible();

    await logout(page);
    await login(page, { email: memberEmail, password: 'a-brand-new-password-456' });
    // Logging out from `/profile` redirects to `/login` carrying that page
    // as `location.state.from` (the same `RequireAuth` mechanism an
    // unauthenticated deep link uses — see `RouteGuards.jsx`); logging back
    // in returns here, to `/profile`, not `/member` — a real, intentional
    // behavior for a page every role can reach, not a bug.
    await expect(page).toHaveURL(/\/profile$/);
  });

  test('no unexpected console/network errors occurred across the member journey', () => {
    diag.assertClean({ allowExpectedAuthFailures: true });
  });
});

test.describe('member portal — own-bookings-only and authorization boundaries', () => {
  test('a new public signup gets its own member, sees no bookings from another member, and cannot reach staff-only pages', async ({
    page,
  }) => {
    const email = `boundary-member-${Date.now()}@example.com`;
    await signup(page, { fullName: uniqueLabel('Boundary Member'), email });

    await page.locator('nav.sidebar-nav').getByRole('link', { name: 'My Bookings' }).click();
    await expect(page.getByText("You haven't booked any sessions yet.")).toBeVisible();

    // The member nav has no staff/instructor links at all — an honest
    // reflection of what this account can do. The backend independently
    // enforces the same boundary on every request regardless of this nav.
    const nav = page.locator('nav.sidebar-nav');
    await expect(nav.getByRole('link')).toHaveCount(4);
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Members' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Classes' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Alerts' })).toHaveCount(0);

    // Direct navigation to a staff-only page redirects away client-side
    // (`RequireStaff`) — a UX convenience, not the authorization boundary
    // itself: `backend/tests/memberPortal.test.js` separately proves the
    // backend independently rejects a member's request to every staff-only
    // endpoint with a real 403, regardless of what this route guard does.
    await page.goto('/dashboard');
    await expect(page).not.toHaveURL(/\/dashboard$/);
  });

  test('a brand-new signup with no staff-granted membership cannot book — the expired-membership rule blocks it, with a clean message', async ({
    browser,
  }) => {
    // A dedicated staff page to guarantee a bookable session exists,
    // independent of any other test's fixtures.
    const staffPage = await browser.newPage();
    await login(staffPage, STAFF);
    const className = uniqueLabel('Expiry Rule Class');

    await staffPage.getByRole('link', { name: 'Classes' }).click();
    await staffPage.getByRole('button', { name: 'Create class' }).click();
    const classDialog = staffPage.getByRole('dialog');
    await classDialog.getByLabel('Title').fill(className);
    await classDialog.getByLabel('Discipline').fill('Expiry Rule Testing');
    await classDialog.getByLabel('Default duration (minutes)').fill('30');
    await classDialog.getByLabel('Default capacity').fill('3');
    await classDialog.getByRole('button', { name: 'Create class', exact: true }).click();
    await expect(classDialog).not.toBeVisible();

    await staffPage.getByRole('link', { name: 'Sessions', exact: true }).click();
    await staffPage.getByRole('button', { name: 'Create session' }).click();
    const sessionDialog = staffPage.getByRole('dialog');
    await sessionDialog.getByLabel('Class', { exact: true }).selectOption({ label: className });
    await sessionDialog.getByLabel('Primary instructor').selectOption({ label: INSTRUCTOR.fullName });
    await sessionDialog.getByLabel('Room').selectOption({ label: SEED_ROOM_NAME });
    await sessionDialog
      .getByLabel('Starts at (your local time)')
      .fill(toDatetimeLocalValue(randomFutureDayOffset()));
    await sessionDialog.getByRole('button', { name: 'Create session', exact: true }).click();
    await expect(sessionDialog).not.toBeVisible();
    await staffPage.close();

    const memberPage = await browser.newPage();
    const email = `expired-signup-${Date.now()}@example.com`;
    await signup(memberPage, { fullName: uniqueLabel('Expired Signup'), email });

    await memberPage.getByRole('link', { name: 'Sessions', exact: true }).click();
    await expect(memberPage).toHaveURL(/\/member\/sessions$/);

    // Browsing itself is still allowed while expired — only creating a new
    // booking is blocked (the backend's authoritative rule; see
    // `domain/membership.js#isMembershipExpired`).
    const card = memberPage.locator('.member-session-card').filter({ hasText: className });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /book|join waitlist/i }).click();

    const alert = memberPage.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/membership expired/i);
    await expect(alert).not.toContainText(/^409:/);
    // The rejected attempt never actually created a booking.
    await expect(card.getByText('Booked', { exact: true })).toHaveCount(0);

    await memberPage.close();
  });
});

// Regression coverage for a real bug: booking a second session was
// silently reverting the first session's card back to "Book", because
// booking state was tracked in one shared `justBookedId` scalar instead of
// being read per-session from the backend. See docs/decisions.md.
test.describe.serial('member session browsing — per-session booking state and filters', () => {
  let page;
  const memberEmail = `state-bug-member-${Date.now()}@example.com`;
  const className = uniqueLabel('State Bug Class');

  test.beforeAll(async ({ browser }) => {
    const staffPage = await browser.newPage();
    await login(staffPage, STAFF);

    // A real membership, staff-created before the member ever signs up —
    // the same claim-by-email-at-signup path `member-portal.spec.js`'s
    // first describe block already exercises, needed here only so this
    // member's bookings are actually allowed (a brand-new, never-linked
    // signup starts with an already-expired membership by design).
    await staffPage.getByRole('link', { name: 'Members' }).click();
    await staffPage.getByRole('button', { name: 'Add member' }).click();
    const memberDialog = staffPage.getByRole('dialog');
    await memberDialog.getByLabel('Full name').fill('State Bug Member');
    await memberDialog.getByLabel('Email').fill(memberEmail);
    await memberDialog.getByLabel('Membership expires on').fill(isoDate(180));
    await memberDialog.getByRole('button', { name: 'Add member', exact: true }).click();
    await expect(memberDialog).not.toBeVisible();

    await staffPage.getByRole('link', { name: 'Classes' }).click();
    await staffPage.getByRole('button', { name: 'Create class' }).click();
    const classDialog = staffPage.getByRole('dialog');
    await classDialog.getByLabel('Title').fill(className);
    await classDialog.getByLabel('Discipline').fill('State Bug Testing');
    await classDialog.getByLabel('Default duration (minutes)').fill('45');
    await classDialog.getByLabel('Default capacity').fill('5');
    await classDialog.getByRole('button', { name: 'Create class', exact: true }).click();
    await expect(classDialog).not.toBeVisible();

    async function createSession(dayOffset) {
      await staffPage.getByRole('link', { name: 'Sessions', exact: true }).click();
      await staffPage.getByRole('button', { name: 'Create session' }).click();
      const dialog = staffPage.getByRole('dialog');
      await dialog.getByLabel('Class', { exact: true }).selectOption({ label: className });
      await dialog.getByLabel('Primary instructor').selectOption({ label: INSTRUCTOR.fullName });
      await dialog.getByLabel('Room').selectOption({ label: SEED_ROOM_NAME });
      await dialog.getByLabel('Starts at (your local time)').fill(toDatetimeLocalValue(dayOffset));
      await dialog.getByRole('button', { name: 'Create session', exact: true }).click();
      await expect(dialog).not.toBeVisible();
    }

    // Two well-separated future days, so the two sessions can never collide
    // with each other or with any other spec file's own fixtures.
    await createSession(randomFutureDayOffset(2000, 700));
    await createSession(randomFutureDayOffset(2000, 3000));
    await staffPage.close();

    page = await browser.newPage();
    await signup(page, { fullName: 'Different Name At Signup', email: memberEmail });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('books session A, then session B — session A must still show Booked, never reverted', async () => {
    await page.goto('/member/sessions');
    await page.waitForSelector('.member-session-card');

    const cards = page.locator('.member-session-card').filter({ hasText: className });
    await expect(cards).toHaveCount(2);

    const cardA = cards.nth(0);
    const cardB = cards.nth(1);

    await cardA.getByRole('button', { name: /^book$/i }).click();
    await expect(cardA.getByText('Booked', { exact: true })).toBeVisible();

    // The exact bug: booking B must never revert A.
    await cardB.getByRole('button', { name: /^book$/i }).click();
    await expect(cardB.getByText('Booked', { exact: true })).toBeVisible();
    await expect(cardA.getByText('Booked', { exact: true })).toBeVisible();
    await expect(cardA.getByRole('button', { name: /^book$/i })).toHaveCount(0);
  });

  test('both bookings appear in My Bookings', async () => {
    await page.getByRole('link', { name: 'My Bookings' }).click();
    await expect(page).toHaveURL(/\/member\/bookings$/);
    const rows = page.locator('table.table tbody tr').filter({ hasText: className });
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) {
      await expect(row.getByText('Booked', { exact: true })).toBeVisible();
    }
  });

  test('surviving a refresh: both sessions still show Booked after reloading the page', async () => {
    await page.goto('/member/sessions');
    await page.waitForSelector('.member-session-card');
    await page.reload();
    await page.waitForSelector('.member-session-card');

    const cards = page.locator('.member-session-card').filter({ hasText: className });
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0).getByText('Booked', { exact: true })).toBeVisible();
    await expect(cards.nth(1).getByText('Booked', { exact: true })).toBeVisible();
  });

  test('the class filter narrows the list without losing either session’s Booked state', async () => {
    await page.getByLabel('Class').selectOption({ label: className });
    await expect(page).toHaveURL(/classId=/);

    const cards = page.locator('.member-session-card').filter({ hasText: className });
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0).getByText('Booked', { exact: true })).toBeVisible();
    await expect(cards.nth(1).getByText('Booked', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).not.toHaveURL(/classId=/);
  });

  test('the "My booked sessions" availability filter shows both bookings, not only the most recent one', async () => {
    await page.getByLabel('Availability').selectOption({ label: 'My booked sessions' });
    await expect(page).toHaveURL(/availability=mine/);

    const cards = page.locator('.member-session-card').filter({ hasText: className });
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0).getByText('Booked', { exact: true })).toBeVisible();
    await expect(cards.nth(1).getByText('Booked', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Clear filters' }).click();
  });

  test('cancelling one booking changes only that session’s state, in both My Bookings and the session browser', async () => {
    await page.getByRole('link', { name: 'My Bookings' }).click();
    const rows = page.locator('table.table tbody tr').filter({ hasText: className });
    await expect(rows).toHaveCount(2);

    // Cancel the first row only.
    await rows.nth(0).getByRole('button', { name: 'Cancel' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /cancel booking/i }).click();
    await expect(rows.nth(0).getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(rows.nth(1).getByText('Booked', { exact: true })).toBeVisible();

    // Back on the session browser: exactly one card lost its Booked state,
    // the other kept it.
    await page.getByRole('link', { name: 'Sessions', exact: true }).click();
    const cards = page.locator('.member-session-card').filter({ hasText: className });
    await expect(cards).toHaveCount(2);
    const bookedCards = cards.filter({ hasText: 'Booked' });
    const bookableCards = cards.filter({ has: page.getByRole('button', { name: /^book$/i }) });
    await expect(bookedCards).toHaveCount(1);
    await expect(bookableCards).toHaveCount(1);
  });
});
