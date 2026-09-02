import { expect, test } from '@playwright/test';

import {
  INSTRUCTOR,
  SECOND_INSTRUCTOR,
  SEED_ROOM_NAME,
  STAFF,
  attachDiagnostics,
  login,
  randomFutureDayOffset,
  uniqueLabel,
} from './fixtures.js';

function isoDate(daysFromNow) {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

function toDatetimeLocalValue(daysFromNow) {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  d.setHours(9, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

// One continuous, ordered journey through every mandatory staff workflow —
// steps genuinely depend on each other (the member created in step 7 is the
// one dismissed in step 12; the session created in step 20 is the one
// booked, cancelled, and CSV-exported later), so `serial` mode (one shared
// page, tests run in file order, a failure skips the rest rather than
// continuing against a broken precondition) is the right tool here, not
// independent per-test isolation.
test.describe.serial('staff — full application journey', () => {
  let page;
  let diag;
  let sessionId;

  const memberName = uniqueLabel('E2E Member');
  const memberEmail = `e2e-member-${Date.now()}@example.com`;
  const className = uniqueLabel('E2E Class');
  // Two independent random future windows — one for the single session
  // this journey creates, one for the recurring-generation block — far
  // enough apart, and re-randomized every run, that neither this run's own
  // two fixtures nor a previous run's leftover fixtures ever collide on
  // room/instructor scheduling.
  const sessionDayOffset = randomFutureDayOffset();
  const recurringDayOffset = randomFutureDayOffset();

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    diag = attachDiagnostics(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('1-4: opens /login, signs in as staff, lands on the dashboard', async () => {
    await login(page, STAFF);
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('5: dashboard renders every required metric section', async () => {
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByText('Sessions today')).toBeVisible();
    await expect(page.getByText('Bookings made today')).toBeVisible();
    await expect(page.getByText('No-shows this week')).toBeVisible();
    await expect(page.getByText('Members currently waitlisted')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bookings by status' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bookings by class' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Attendance — last 8 weeks' })).toBeVisible();
    // Every headline value must actually be a number the server sent, never
    // a blank/placeholder — matches "render exactly what the backend
    // returned" (docs/architecture.md).
    const statValues = await page.locator('.stat-value').allTextContents();
    expect(statValues).toHaveLength(4);
    for (const value of statValues) expect(value.trim()).toMatch(/^\d+$/);
  });

  test('6-9: creates a member and verifies it appears', async () => {
    await page.getByRole('link', { name: 'Members' }).click();
    await expect(page).toHaveURL(/\/members$/);

    await page.getByRole('button', { name: 'Add member' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Full name').fill(memberName);
    await dialog.getByLabel('Email').fill(memberEmail);
    await dialog.getByLabel('Membership expires on').fill(isoDate(365));
    await dialog.getByRole('button', { name: 'Add member', exact: true }).click();

    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(memberName) })).toBeVisible();
  });

  test('9: edits that member\'s membership expiry into the alert window', async () => {
    const row = page.getByRole('row', { name: new RegExp(memberName) });
    await row.getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Edit member' })).toBeVisible();
    await dialog.getByLabel('Membership expires on').fill(isoDate(2));
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row).toContainText(isoDate(2));
  });

  test('10-13: the member appears in Alerts, and dismissing it removes it', async () => {
    await page.getByRole('link', { name: 'Alerts' }).click();
    await expect(page).toHaveURL(/\/alerts$/);

    const row = page.getByRole('row', { name: new RegExp(memberName) });
    await expect(row).toBeVisible();
    await expect(row.getByText('Expiring soon')).toBeVisible();

    await row.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByRole('row', { name: new RegExp(memberName) })).toHaveCount(0);
  });

  test('14-18: creates, edits, archives, and restores a class', async () => {
    await page.getByRole('link', { name: 'Classes' }).click();
    await expect(page).toHaveURL(/\/classes$/);

    await page.getByRole('button', { name: 'Create class' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Title').fill(className);
    await dialog.getByLabel('Discipline').fill('E2E Testing');
    await dialog.getByLabel('Default duration (minutes)').fill('45');
    await dialog.getByLabel('Default capacity').fill('8');
    await dialog.getByRole('button', { name: 'Create class', exact: true }).click();
    await expect(dialog).not.toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(className) });
    await expect(row).toBeVisible();
    await expect(row.getByText('Active')).toBeVisible();

    // Edit
    await row.getByRole('button', { name: 'Edit' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Default capacity').fill('12');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row).toContainText('12');

    // "Show archived classes" defaults to off, which excludes archived
    // classes from the list entirely — check it first so the row (and its
    // new "Archived" badge) stays visible for the assertion below instead
    // of disappearing the moment it's archived.
    await page.getByRole('checkbox', { name: 'Show archived classes' }).check();

    // Archive
    await row.getByRole('button', { name: 'Archive' }).click();
    await expect(row.getByText('Archived')).toBeVisible();

    // Restore
    await row.getByRole('button', { name: 'Restore' }).click();
    await expect(row.getByText('Active')).toBeVisible();
  });

  test('19-21: creates a session using real room/instructor options, then opens its detail', async () => {
    await page.getByRole('link', { name: 'Sessions', exact: true }).click();
    await expect(page).toHaveURL(/\/sessions$/);

    await page.getByRole('button', { name: 'Create session' }).click();
    const dialog = page.getByRole('dialog');
    // `exact: true` matters here: the form's own Duration/Capacity labels
    // read "...defaults from class", which a substring match on "Class"
    // would otherwise also match (Playwright strict mode then refuses to
    // pick between three ambiguous matches).
    await dialog.getByLabel('Class', { exact: true }).selectOption({ label: className });
    await dialog.getByLabel('Primary instructor').selectOption({ label: INSTRUCTOR.fullName });
    await dialog.getByLabel('Room').selectOption({ label: SEED_ROOM_NAME });
    await dialog.getByLabel('Starts at (your local time)').fill(toDatetimeLocalValue(sessionDayOffset));
    await dialog.getByRole('button', { name: 'Create session', exact: true }).click();
    await expect(dialog).not.toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(className) });
    await expect(row).toBeVisible();
    await row.getByRole('link', { name: 'View' }).click();
    await expect(page).toHaveURL(/\/sessions\/\d+$/);
    await expect(page.getByRole('heading', { name: /^Session #\d+$/ })).toBeVisible();
    sessionId = page.url().match(/\/sessions\/(\d+)$/)[1];
  });

  test('22: adds and then removes a co-instructor', async () => {
    await page.getByText('No co-instructors assigned.').waitFor();

    const addForm = page.locator('form.inline-form').filter({ hasText: 'co-instructor' });
    await addForm.locator('select').selectOption({ label: SECOND_INSTRUCTOR.fullName });
    await addForm.getByRole('button', { name: 'Add' }).click();

    const coInstructorRow = page.locator('.plain-list li', { hasText: SECOND_INSTRUCTOR.fullName });
    await expect(coInstructorRow).toBeVisible();

    await coInstructorRow.getByRole('button', { name: 'Remove' }).click();
    await expect(coInstructorRow).toHaveCount(0);
    await expect(page.getByText('No co-instructors assigned.')).toBeVisible();
  });

  test('23-24: generates recurring sessions and renders both created and skipped', async () => {
    await page.getByRole('link', { name: 'Sessions', exact: true }).click();
    await page.getByRole('link', { name: 'Generate recurring' }).click();
    await expect(page).toHaveURL(/\/sessions\/recurring$/);

    const startDate = isoDate(recurringDayOffset);
    const endDate = isoDate(recurringDayOffset + 6);
    const weekday = weekdayOf(startDate);
    const dayCheckbox = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday];

    await page.getByLabel('Class').selectOption({ label: className });
    await page.getByLabel('Primary instructor').selectOption({ label: INSTRUCTOR.fullName });
    await page.getByLabel('Room').selectOption({ label: SEED_ROOM_NAME });
    await page.getByLabel('Start date').fill(startDate);
    await page.getByLabel('End date').fill(endDate);
    await page.getByLabel('Local start time').fill('09:00');
    // Only the one matching weekday chip needs to be checked; deselect any
    // other defaulted-on day first for a fully deterministic single
    // candidate on the first submission.
    for (const label of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      const checkbox = page.getByRole('checkbox', { name: label });
      const checked = await checkbox.isChecked();
      if (label === dayCheckbox && !checked) await checkbox.check();
      if (label !== dayCheckbox && checked) await checkbox.uncheck();
    }

    await page.getByRole('button', { name: 'Generate sessions' }).click();
    await expect(page.getByRole('heading', { name: 'Created (1)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Skipped (0)' })).toBeVisible();

    // Submitting the exact same request again must skip the one candidate
    // as an exact duplicate — proving both "created" and "skipped" render,
    // with a real, machine-readable reason, not just the happy path.
    await page.getByRole('button', { name: 'Generate sessions' }).click();
    await expect(page.getByRole('heading', { name: 'Created (0)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Skipped (1)' })).toBeVisible();
    await expect(page.getByText('Already exists')).toBeVisible();
  });

  test('25-30: booking search, filter, sort, and pagination', async () => {
    await page.getByRole('link', { name: 'Bookings' }).click();
    await expect(page).toHaveURL(/\/bookings$/);

    // 25-26: search — the member created earlier has a globally-unique name,
    // so search results are deterministic regardless of how much other data
    // this shared environment already holds.
    await page.getByPlaceholder('Search member name or email…').fill(memberName);
    await page.getByPlaceholder('Search member name or email…').press('Enter');
    await expect(page).toHaveURL(/[?&]q=/);
    await expect(page.getByRole('cell', { name: memberName })).toHaveCount(0); // no booking yet for this member
    await expect(page.getByText('No bookings match these filters.')).toBeVisible();

    // Clear the search back out before filtering/sorting/paginating the
    // full (large, shared, non-deterministic-count) list.
    await page.getByPlaceholder('Search member name or email…').fill('');
    await page.getByPlaceholder('Search member name or email…').press('Enter');
    await expect(page).not.toHaveURL(/[?&]q=/);

    // The filter bar's four <select> elements have no individual <label>,
    // so they're addressed by their fixed DOM order: class(0), status(1),
    // sort(2), direction(3) — matches the JSX order in BookingsPage.
    const comboboxes = page.getByRole('combobox');
    const statusSelect = comboboxes.nth(1);
    const directionSelect = comboboxes.nth(3);

    // 27: filter by status — asserting only that the filter takes effect
    // (URL updates, page renders without error) rather than an exact
    // resulting count, since this shared environment's total cancelled-
    // booking count isn't deterministic from this test's own actions alone.
    await statusSelect.selectOption('cancelled');
    await expect(page).toHaveURL(/status=cancelled/);
    await expect(
      page.locator('table.table').or(page.getByText('No bookings match these filters.')),
    ).toBeVisible();

    // 28: change sort direction
    await directionSelect.selectOption('asc');
    await expect(page).toHaveURL(/direction=asc/);
    await expect(
      page.locator('table.table').or(page.getByText('No bookings match these filters.')),
    ).toBeVisible();

    // Reset filters back to "all" for a large, multi-page result set.
    await statusSelect.selectOption('');
    await expect(page).not.toHaveURL(/status=/);

    // 29-30: pagination — this shared environment always has far more than
    // one page of bookings (seed + every backend test suite's own
    // permanent fixtures), so "Next" is expected to be enabled here.
    const nextButton = page.getByRole('button', { name: 'Next' });
    await expect(nextButton).toBeEnabled();
    const summary = page.locator('.pagination-summary');
    const beforeSummary = await summary.textContent();
    await nextButton.click();
    await expect(page).toHaveURL(/page=2/);
    // The URL updates synchronously on click, but the page-2 data fetch and
    // re-render are async — reading textContent() immediately after would
    // race the still-in-flight request. `toHaveText` polls until it matches
    // (or times out as a real failure), rather than reading a snapshot.
    await expect(summary).toHaveText(/^Page 2 of/);
    await expect(summary).not.toHaveText(beforeSummary);
  });

  test('31-32: creates a booking for the earlier member/session, then cancels it', async () => {
    await page.goto('/bookings');
    await page.getByRole('button', { name: 'Create booking' }).click();
    const dialog = page.getByRole('dialog');
    // `selectOption`'s `label` must be an exact string, not a pattern — but
    // the option's full text is entirely known already (it's rendered as
    // `${fullName} (${email})`, and both are this test's own fixtures).
    await dialog.getByLabel('Member').selectOption({ label: `${memberName} (${memberEmail})` });
    // Pick the exact session created in step 19-21 by its id, captured from
    // that step's URL — not by guessing at a locale-formatted date string.
    await dialog.getByLabel('Session').selectOption({ value: sessionId });

    await dialog.getByRole('button', { name: 'Create booking', exact: true }).click();
    await expect(dialog).not.toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(memberName) });
    await expect(row).toBeVisible();
    await expect(row.getByText('Booked')).toBeVisible();

    await row.getByRole('button', { name: 'Cancel' }).click();
    const confirmDialog = page.getByRole('dialog');
    await confirmDialog.getByRole('button', { name: 'Cancel booking' }).click();
    await expect(confirmDialog).not.toBeVisible();
    await expect(row.getByText('Cancelled')).toBeVisible();
  });

  test('33-34: opens booking detail and verifies history is displayed', async () => {
    const row = page.getByRole('row', { name: new RegExp(memberName) });
    await row.getByRole('link', { name: memberName }).click();
    await expect(page).toHaveURL(/\/bookings\/\d+$/);

    await expect(page.getByRole('heading', { name: /^Booking #\d+$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();

    const timelineItems = page.locator('.timeline-item');
    // created -> booked, then status_changed -> cancelled: at least two
    // immutable history entries, exactly what goal 9 promises.
    await expect(timelineItems).toHaveCount(2);
    await expect(timelineItems.nth(0)).toContainText('Created');
    await expect(timelineItems.nth(1)).toContainText('Status changed');
  });

  test('35-36: downloads the session\'s attendance CSV and verifies its content', async () => {
    // The CSV is per-session, not per-booking — go straight to the session
    // created in step 19-21 (its id was captured from that step's URL).
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.getByRole('heading', { name: /^Session #\d+$/ })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download attendance CSV' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^attendance-session-\d+-\d{4}-\d{2}-\d{2}\.csv$/);

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const fs = await import('node:fs');
    const content = fs.readFileSync(downloadPath, 'utf8');

    expect(content.split('\r\n')[0]).toBe('Booking ID,Member Name,Member Email,Status,Booked At');
    expect(content).toContain(memberName);
    expect(content).toContain(memberEmail);
    expect(content).toContain('cancelled');
  });

  test('no unexpected console/network errors occurred across the whole staff journey', () => {
    // The very first page load of this suite is `login()`'s own
    // `page.goto('/login')`, which happens before any session cookie
    // exists — the resulting `GET /api/auth/me` 401 is the app's intended
    // "no session yet" signal, not a bug (see fixtures.js).
    diag.assertClean({ allowExpectedAuthFailures: true });
  });
});
