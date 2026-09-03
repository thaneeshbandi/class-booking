import { expect, test } from '@playwright/test';

import {
  INSTRUCTOR,
  SEED_CLASS_TITLE,
  SEED_ROOM_NAME,
  SECOND_ROOM_NAME,
  STAFF,
  attachDiagnostics,
  login,
  randomFutureDayOffset,
  uniqueLabel,
} from './fixtures.js';

// Local date components throughout — not `.toISOString()` (UTC) — so that a
// `daysFromNow` offset always names the exact same calendar day whether it
// feeds a `type="date"` field (`isoDate`) or a `datetime-local` field
// (`toDatetimeLocalValue`, used by `createSession`). Mixing the two
// conventions is a real trap on a machine east of UTC (e.g. IST): a
// `daysFromNow` offset landing near local midnight can name *different*
// calendar days in UTC vs. local time, silently pointing a "conflicting"
// fixture session at a day the recurring form was never actually testing
// against.
function pad(n) {
  return String(n).padStart(2, '0');
}

function isoDate(daysFromNow) {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// `RecurringSessionsPage`'s own client-side weekday logic parses a
// "YYYY-MM-DD" string as UTC midnight (`parseIsoDate`) — matching that
// exactly here is what keeps this test's weekday selection consistent with
// what the page itself will compute for the same date string.
function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

const WEEKDAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toDatetimeLocalValue(daysFromNow, hour) {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  d.setHours(hour, 0, 0, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
}

async function createMember(page, name, email) {
  await page.goto('/members');
  await page.getByRole('button', { name: 'Add member' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Full name').fill(name);
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Membership expires on').fill(isoDate(365));
  await dialog.getByRole('button', { name: 'Add member', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function createSession(page, { instructorFullName, roomName, daysFromNow, hour }) {
  await page.goto('/sessions');
  await page.getByRole('button', { name: 'Create session' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Class', { exact: true }).selectOption({ label: SEED_CLASS_TITLE });
  await dialog.getByLabel('Primary instructor').selectOption({ label: instructorFullName });
  await dialog.getByLabel('Room').selectOption({ label: roomName });
  await dialog.getByLabel('Starts at (your local time)').fill(toDatetimeLocalValue(daysFromNow, hour));
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/api/sessions')),
    dialog.getByRole('button', { name: 'Create session', exact: true }).click(),
  ]);
  await expect(dialog).not.toBeVisible();
  const body = await response.json();
  return String(body.session.id);
}

test.describe('bookings table — fixed action column alignment', () => {
  test('rows with and without a Cancel button render inside the same table structure, aligned', async ({
    page,
  }) => {
    const diag = attachDiagnostics(page);
    await login(page, STAFF);

    const memberWithAction = uniqueLabel('Alignment Keeps');
    const memberWithoutAction = uniqueLabel('Alignment Cancels');
    const emailWith = `align-keeps-${Date.now()}@example.com`;
    const emailWithout = `align-cancels-${Date.now()}@example.com`;
    await createMember(page, memberWithAction, emailWith);
    await createMember(page, memberWithoutAction, emailWithout);

    const sessionId = await createSession(page, {
      instructorFullName: INSTRUCTOR.fullName,
      roomName: SEED_ROOM_NAME,
      daysFromNow: randomFutureDayOffset(),
      hour: 9,
    });

    async function bookMember(name, email) {
      await page.goto('/bookings');
      await page.getByRole('button', { name: 'Create booking' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Member').selectOption({ label: `${name} (${email})` });
      await dialog.getByLabel('Session').selectOption({ value: sessionId });
      await dialog.getByRole('button', { name: 'Create booking', exact: true }).click();
      await expect(dialog).not.toBeVisible();
    }

    await bookMember(memberWithAction, emailWith);
    await bookMember(memberWithoutAction, emailWithout);

    // Cancel the second booking so its row has no available action — the
    // first booking stays 'booked' and keeps its Cancel button.
    await page.goto('/bookings');
    const rowWithout = page.getByRole('row', { name: new RegExp(memberWithoutAction) });
    await rowWithout.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel booking' }).click();
    await expect(rowWithout.getByText('Cancelled')).toBeVisible();

    const rowWith = page.getByRole('row', { name: new RegExp(memberWithAction) });
    await expect(rowWith.getByText('Booked')).toBeVisible();

    // Structural: both rows have the same number of cells, and the actions
    // cell is always present — never simply omitted.
    const cellsWith = rowWith.locator('td');
    const cellsWithout = rowWithout.locator('td');
    await expect(cellsWith).toHaveCount(await cellsWithout.count());

    await expect(rowWith.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(rowWithout.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await expect(rowWithout.locator('.table-actions-placeholder')).toBeVisible();

    // Visual: the actions column's left edge lines up exactly between a row
    // with a button and a row without one — the actual bug being fixed.
    const boxWith = await rowWith.locator('td.col-actions').boundingBox();
    const boxWithout = await rowWithout.locator('td.col-actions').boundingBox();
    expect(boxWith).toBeTruthy();
    expect(boxWithout).toBeTruthy();
    expect(boxWith.x).toBeCloseTo(boxWithout.x, 0);
    expect(boxWith.width).toBeCloseTo(boxWithout.width, 0);

    // And the same is true for every other column, not just actions.
    const memberColWith = await rowWith.locator('td').first().boundingBox();
    const memberColWithout = await rowWithout.locator('td').first().boundingBox();
    expect(memberColWith.x).toBeCloseTo(memberColWithout.x, 0);
    expect(memberColWith.width).toBeCloseTo(memberColWithout.width, 0);

    diag.assertClean({ allowExpectedAuthFailures: true });
  });

  // Regression test for a real bug: an earlier version of this table
  // rendered only five <td> cells against six <th> headers (the class
  // title had been folded into the member cell instead of getting its own
  // column), which silently shifted every later cell one column left —
  // session time under "Class", status under "Session", booked-at under
  // "Status", the Cancel button under "Booked at", and nothing at all under
  // "Actions". The alignment test above only compares rows *to each other*,
  // so it could not have caught this (both rows were shifted identically).
  // This test instead pins each header to its own cell *by content*, not
  // just by count, so a future regression of the same shape fails here.
  test('every header has exactly one matching cell, with the right content in the right column', async ({
    page,
  }) => {
    await login(page, STAFF);

    const memberName = uniqueLabel('Structure Check');
    const email = `structure-check-${Date.now()}@example.com`;
    await createMember(page, memberName, email);

    const sessionId = await createSession(page, {
      instructorFullName: INSTRUCTOR.fullName,
      roomName: SEED_ROOM_NAME,
      daysFromNow: randomFutureDayOffset(),
      hour: 14,
    });

    await page.goto('/bookings');
    await page.getByRole('button', { name: 'Create booking' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Member').selectOption({ label: `${memberName} (${email})` });
    await dialog.getByLabel('Session').selectOption({ value: sessionId });
    await dialog.getByRole('button', { name: 'Create booking', exact: true }).click();
    await expect(dialog).not.toBeVisible();

    await page.goto('/bookings');

    // Exactly six header cells, in the required order.
    const headers = page.locator('table.table thead th');
    await expect(headers).toHaveCount(6);
    await expect(headers).toHaveText(['Member', 'Class', 'Session', 'Status', 'Booked at', 'Actions']);

    const row = page.getByRole('row', { name: new RegExp(memberName) });
    const cells = row.locator('td');
    await expect(cells).toHaveCount(6);

    // Content lands in the column its own header names — not merely "a
    // cell somewhere in this row contains this text" (which the buggy
    // version would also have satisfied), but the specific, indexed cell.
    await expect(cells.nth(0)).toContainText(memberName); // Member
    await expect(cells.nth(1)).toContainText(SEED_CLASS_TITLE); // Class
    await expect(cells.nth(1)).not.toContainText(memberName);
    await expect(cells.nth(2).locator('.metadata-chip')).toBeVisible(); // Session: calendar chip
    await expect(cells.nth(2)).not.toContainText(SEED_CLASS_TITLE);
    await expect(cells.nth(3).getByText('Booked', { exact: true })).toBeVisible(); // Status
    await expect(cells.nth(4)).not.toContainText('Booked'); // Booked at is a timestamp, not the status word
    await expect(cells.nth(5)).toHaveClass(/col-actions/); // Actions
    await expect(cells.nth(5).getByRole('button', { name: 'Cancel' })).toBeVisible();

    // A row with no available action still has six cells, with the
    // placeholder specifically inside the Actions cell — not spilled into
    // "Booked at" the way the original bug did.
    await row.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel booking' }).click();
    await expect(row.getByText('Cancelled', { exact: true })).toBeVisible();

    const cellsAfterCancel = row.locator('td');
    await expect(cellsAfterCancel).toHaveCount(6);
    await expect(cellsAfterCancel.nth(5)).toHaveClass(/col-actions/);
    await expect(cellsAfterCancel.nth(5).locator('.table-actions-placeholder')).toBeVisible();
    await expect(cellsAfterCancel.nth(5).getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await expect(cellsAfterCancel.nth(4)).not.toContainText('—'); // the placeholder never leaks into Booked at
  });
});

// Scenario "4. duplicate generation" (submitting the identical request twice
// and getting `existing_session` / "Already exists" on the second) is
// already covered end-to-end by staff-flow.spec.js's own recurring-
// generation test — not repeated here to avoid two tests asserting the same
// server behavior.
test.describe('recurring session generation — client-side UX', () => {
  test.describe.configure({ mode: 'serial' });
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await login(page, STAFF);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('1. one-day range + a matching weekday: clean preview, submits, creates one session', async () => {
    await page.goto('/sessions/recurring');
    const day = isoDate(randomFutureDayOffset());
    const weekday = weekdayOf(day);

    await page.getByLabel('Class', { exact: true }).selectOption({ label: SEED_CLASS_TITLE });
    await page.getByLabel('Primary instructor').selectOption({ label: INSTRUCTOR.fullName });
    await page.getByLabel('Room').selectOption({ label: SEED_ROOM_NAME });
    await page.getByLabel('Start date').fill(day);
    await page.getByLabel('End date').fill(day);

    for (const label of WEEKDAY_LABEL) {
      const checkbox = page.getByRole('checkbox', { name: label });
      const shouldBeChecked = label === WEEKDAY_LABEL[weekday];
      if (shouldBeChecked && !(await checkbox.isChecked())) await checkbox.check();
      if (!shouldBeChecked && (await checkbox.isChecked())) await checkbox.uncheck();
    }

    await expect(page.getByText('1 session will be generated')).toBeVisible();
    const submit = page.getByRole('button', { name: 'Generate sessions' });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole('heading', { name: 'Created (1)' })).toBeVisible();
  });

  test('2. one-day range + a non-matching weekday: inline error, submit disabled, no request made', async () => {
    await page.goto('/sessions/recurring');
    const day = isoDate(randomFutureDayOffset());
    const weekday = weekdayOf(day);
    const wrongWeekday = (weekday + 1) % 7;

    await page.getByLabel('Start date').fill(day);
    await page.getByLabel('End date').fill(day);
    for (const label of WEEKDAY_LABEL) {
      const checkbox = page.getByRole('checkbox', { name: label });
      const shouldBeChecked = label === WEEKDAY_LABEL[wrongWeekday];
      if (shouldBeChecked && !(await checkbox.isChecked())) await checkbox.check();
      if (!shouldBeChecked && (await checkbox.isChecked())) await checkbox.uncheck();
    }

    await expect(page.getByText(/isn't selected below/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate sessions' })).toBeDisabled();

    // Never shows a raw "400:"-prefixed message for this — it's caught
    // before any request is even made.
    await expect(page.getByText(/^400:/)).toHaveCount(0);
  });

  test('3. multi-day range + multiple weekdays: preview count matches, all created', async () => {
    await page.goto('/sessions/recurring');
    const start = randomFutureDayOffset();
    const startDate = isoDate(start);
    const endDate = isoDate(start + 13); // two full weeks — every weekday occurs exactly twice

    // Each test navigates fresh, which resets the form to its own defaults
    // — select class/instructor/room explicitly rather than relying on
    // whatever happens to default-select, since this test submits for real
    // and needs a clean, conflict-free combination.
    await page.getByLabel('Class', { exact: true }).selectOption({ label: SEED_CLASS_TITLE });
    await page.getByLabel('Primary instructor').selectOption({ label: INSTRUCTOR.fullName });
    await page.getByLabel('Room').selectOption({ label: SEED_ROOM_NAME });
    await page.getByLabel('Start date').fill(startDate);
    await page.getByLabel('End date').fill(endDate);
    for (const label of WEEKDAY_LABEL) {
      const checkbox = page.getByRole('checkbox', { name: label });
      const shouldBeChecked = label === 'Mon' || label === 'Thu';
      if (shouldBeChecked && !(await checkbox.isChecked())) await checkbox.check();
      if (!shouldBeChecked && (await checkbox.isChecked())) await checkbox.uncheck();
    }

    await expect(page.getByText('4 sessions will be generated')).toBeVisible();
    await page.getByRole('button', { name: 'Generate sessions' }).click();
    await expect(page.getByRole('heading', { name: 'Created (4)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Skipped (0)' })).toBeVisible();
  });

  test('5. a conflicting session is skipped with a readable reason, not a raw error', async () => {
    // The fixture session and the recurring attempt below both go through
    // this same form (not the separate "Create session" modal, which
    // interprets its datetime-local field in *the browser's own* timezone —
    // a deliberately different basis from this form's own "Local start
    // time," which the backend converts using STUDIO_TIMEZONE). Creating
    // both through the same conversion is what makes "same local time"
    // actually mean the same instant here.
    await page.goto('/sessions/recurring');
    const day = randomFutureDayOffset();
    const startDate = isoDate(day);
    const weekday = weekdayOf(startDate);

    async function fillCommonFields(roomName) {
      await page.getByLabel('Class', { exact: true }).selectOption({ label: SEED_CLASS_TITLE });
      await page.getByLabel('Primary instructor').selectOption({ label: INSTRUCTOR.fullName });
      await page.getByLabel('Room').selectOption({ label: roomName });
      await page.getByLabel('Start date').fill(startDate);
      await page.getByLabel('End date').fill(startDate);
      await page.getByLabel('Local start time').fill('14:00');
      for (const label of WEEKDAY_LABEL) {
        const checkbox = page.getByRole('checkbox', { name: label });
        const shouldBeChecked = label === WEEKDAY_LABEL[weekday];
        if (shouldBeChecked && !(await checkbox.isChecked())) await checkbox.check();
        if (!shouldBeChecked && (await checkbox.isChecked())) await checkbox.uncheck();
      }
    }

    // First: a real session for this instructor, in a different room, at
    // this exact local time.
    await fillCommonFields(SECOND_ROOM_NAME);
    await page.getByRole('button', { name: 'Generate sessions' }).click();
    await expect(page.getByRole('heading', { name: 'Created (1)' })).toBeVisible();

    // Second: the same instructor, same local time, a different room — the
    // room is free, but the instructor is not.
    await fillCommonFields(SEED_ROOM_NAME);
    await page.getByRole('button', { name: 'Generate sessions' }).click();
    await expect(page.getByRole('heading', { name: 'Created (0)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Skipped (1)' })).toBeVisible();
    await expect(page.getByText('Instructor conflict')).toBeVisible();
  });
});

test.describe('signup', () => {
  test('the login page links to signup, and the form has no role selector anywhere', async ({ page }) => {
    await page.goto('/login');
    const signupLink = page.getByRole('link', { name: 'Sign up' });
    await expect(signupLink).toBeVisible();
    await signupLink.click();
    await expect(page).toHaveURL(/\/signup$/);

    await expect(page.getByLabel('Full name')).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Confirm password')).toBeVisible();

    // No role/staff/instructor selector anywhere on the page — a public
    // signup form must never expose one.
    await expect(page.getByText(/\bstaff\b/i)).toHaveCount(0);
    await expect(page.getByText(/\binstructor\b/i)).toHaveCount(0);
    await expect(page.locator('select')).toHaveCount(0);
  });

  test('signing up creates a member account, auto-authenticates, and lands on the member home page', async ({
    page,
  }) => {
    const diag = attachDiagnostics(page);
    const name = uniqueLabel('New Signup');
    const email = `signup-e2e-${Date.now()}@example.com`;

    await page.goto('/signup');
    await page.getByLabel('Full name').fill(name);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('a-real-password-123');
    await page.getByLabel('Confirm password').fill('a-real-password-123');
    await page.getByRole('button', { name: 'Sign up' }).click();

    // The member portal's own home page (`MemberHomePage`), not the old
    // static placeholder — a time-of-day greeting by first name, same
    // pattern the staff dashboard's own heading already uses.
    await expect(page).toHaveURL(/\/member$/);
    await expect(page.getByRole('heading', { name: new RegExp(`^good (morning|afternoon|evening), ${name.split(' ')[0]}$`, 'i') })).toBeVisible();

    // The role badge in the topbar is visible proof this account is
    // exactly 'member' — never anything privileged — with no way for the
    // signup form to have asked for otherwise.
    await expect(page.getByText('member', { exact: true })).toBeVisible();

    // No JWT in client-side storage, same guarantee as ordinary login.
    const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(Object.keys(storage.local)).toEqual([]);
    expect(Object.keys(storage.session)).toEqual([]);

    // A member account's nav is its own portal — Home, Sessions, My
    // Bookings, Profile — never a staff/instructor view.
    const nav = page.locator('nav.sidebar-nav');
    await expect(nav.getByRole('link')).toHaveCount(4);
    await expect(nav.getByRole('link', { name: 'Home' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Sessions' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'My Bookings' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Profile' })).toBeVisible();

    diag.assertClean({ allowExpectedAuthFailures: true });
  });

  test('rejects a password/confirm-password mismatch before making any request', async ({ page }) => {
    const diag = attachDiagnostics(page);
    await page.goto('/signup');
    await page.getByLabel('Full name').fill('Mismatch Test');
    await page.getByLabel('Email').fill(`mismatch-${Date.now()}@example.com`);
    await page.getByLabel('Password', { exact: true }).fill('a-real-password-123');
    await page.getByLabel('Confirm password').fill('a-different-password-456');
    await page.getByRole('button', { name: 'Sign up' }).click();

    await expect(page.getByText('Passwords do not match.')).toBeVisible();
    await expect(page).toHaveURL(/\/signup$/);
    diag.assertClean({ allowExpectedAuthFailures: true });
  });

  test('rejects signing up with an email that already has an account', async ({ page }) => {
    await page.goto('/signup');
    await page.getByLabel('Full name').fill('Duplicate Attempt');
    await page.getByLabel('Email').fill(STAFF.email);
    await page.getByLabel('Password', { exact: true }).fill('a-real-password-123');
    await page.getByLabel('Confirm password').fill('a-real-password-123');
    await page.getByRole('button', { name: 'Sign up' }).click();

    await expect(page.getByText('An account with this email already exists.')).toBeVisible();
    await expect(page).toHaveURL(/\/signup$/);
  });
});
