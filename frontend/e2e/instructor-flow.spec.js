import { expect, test } from '@playwright/test';

import {
  INSTRUCTOR,
  SECOND_INSTRUCTOR,
  SEED_CLASS_TITLE,
  SEED_ROOM_NAME,
  STAFF,
  attachDiagnostics,
  login,
  logout,
  randomFutureDayOffset,
} from './fixtures.js';

function toDatetimeLocalValue(daysFromNow, hour) {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  d.setHours(hour, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
}

/** Creates a session as staff and returns its id, read straight from the
 * real `POST /api/sessions` response rather than guessed from the list UI
 * (the seeded "Vinyasa Flow" class already has other sessions, so matching
 * a freshly-created row by visible text alone would be ambiguous). */
async function createSessionAsStaff(page, { instructorFullName, daysFromNow, hour }) {
  await page.goto('/sessions');
  await page.getByRole('button', { name: 'Create session' }).click();
  const dialog = page.getByRole('dialog');
  // `exact: true`: the form's Duration/Capacity labels read "...defaults
  // from class", which a substring match on "Class" would also match.
  await dialog.getByLabel('Class', { exact: true }).selectOption({ label: SEED_CLASS_TITLE });
  await dialog.getByLabel('Primary instructor').selectOption({ label: instructorFullName });
  await dialog.getByLabel('Room').selectOption({ label: SEED_ROOM_NAME });
  await dialog.getByLabel('Starts at (your local time)').fill(toDatetimeLocalValue(daysFromNow, hour));

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().endsWith('/api/sessions'),
    ),
    dialog.getByRole('button', { name: 'Create session', exact: true }).click(),
  ]);
  await expect(dialog).not.toBeVisible();
  const body = await response.json();
  return String(body.session.id);
}

// This suite tests what the seeded instructor Marco Silva can and cannot do
// — both what the UI hides and, more importantly, what the backend itself
// rejects when the UI is bypassed by navigating directly to a URL.
test.describe.serial('instructor — authorization boundaries', () => {
  let page;
  let diag;
  let ownSessionId;
  let foreignSessionId;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    diag = attachDiagnostics(page);

    // Staff sets up two isolated fixture sessions this suite needs — one
    // Marco is the primary instructor for, one he has no relationship to at
    // all (Priya Raman's) — then logs out before the instructor assertions
    // begin. Independently randomized future days (re-picked every process
    // start, unlike a fixed offset) keep the two from ever conflicting with
    // each other, with staff-flow.spec.js's own fixtures, or — critically —
    // with this same file's own leftover fixtures from a previous run
    // against the same persistent database.
    await login(page, STAFF);
    ownSessionId = await createSessionAsStaff(page, {
      instructorFullName: INSTRUCTOR.fullName,
      daysFromNow: randomFutureDayOffset(),
      hour: 9,
    });
    foreignSessionId = await createSessionAsStaff(page, {
      instructorFullName: SECOND_INSTRUCTOR.fullName,
      daysFromNow: randomFutureDayOffset(),
      hour: 9,
    });
    await logout(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('logs in as an instructor and lands on their own session list, not the dashboard', async () => {
    await login(page, INSTRUCTOR);
    await expect(page).toHaveURL(/\/sessions$/);
    await expect(page.getByRole('heading', { name: 'My Sessions', level: 1 })).toBeVisible();
  });

  test('the sidebar shows only instructor-appropriate links', async () => {
    const nav = page.locator('nav.sidebar-nav');
    await expect(nav.getByRole('link', { name: 'My Sessions' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Bookings' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Members' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Alerts' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Classes' })).toHaveCount(0);
  });

  test('the session list has no staff-only mutation controls and is scoped to their own sessions', async () => {
    await expect(page.getByRole('button', { name: 'Create session' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Generate recurring' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    // The own session (Marco is primary) is listed; the unrelated one
    // (Priya's) is not — proving `GET /api/sessions` itself is scoped
    // server-side (goal 5), not merely filtered for display.
    await expect(page.locator(`a[href="/sessions/${ownSessionId}"]`)).toBeVisible();
    await expect(page.locator(`a[href="/sessions/${foreignSessionId}"]`)).toHaveCount(0);
  });

  test('opening their own session detail works, with view-only co-instructor and bookings sections', async () => {
    await page.locator(`a[href="/sessions/${ownSessionId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${ownSessionId}$`));
    await expect(page.getByRole('heading', { name: `Session #${ownSessionId}` })).toBeVisible();

    // canActOnSession is true (they're the primary instructor), so the CSV
    // export is available to them too.
    await expect(page.getByRole('button', { name: 'Download attendance CSV' })).toBeVisible();

    // Co-instructors: visible, but no staff-only add form and no Remove
    // button (isStaff is false).
    await expect(page.getByRole('heading', { name: 'Co-instructors' })).toBeVisible();
    await expect(page.getByText('No co-instructors assigned.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
    await expect(page.getByText('Add a co-instructor…')).toHaveCount(0);

    // Bookings: the "book a member" staff-only form is absent.
    await expect(page.getByRole('heading', { name: 'Bookings' })).toBeVisible();
    await expect(page.getByText('Book a member…')).toHaveCount(0);
  });

  test('direct navigation to a session they have no relationship to is rejected by the backend', async () => {
    await page.goto(`/sessions/${foreignSessionId}`);
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    // The polished error system never shows a raw status number — the
    // backend's 403 is translated to this friendly, specific message (see
    // `components/errorCopy.js`).
    await expect(alert).toContainText(/don't have permission/i);
    await expect(alert).not.toContainText('403');
  });

  test('direct navigation to every staff-only URL redirects back to /sessions', async () => {
    for (const path of ['/dashboard', '/members', '/alerts', '/classes', '/sessions/recurring']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/sessions$/);
    }
  });

  test('the bookings page hides staff-only mutation controls', async () => {
    await page.goto('/bookings');
    await expect(page.getByRole('heading', { name: 'Bookings', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create booking' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  });

  test('no unexpected console/network errors occurred across the instructor journey', () => {
    // Two things are expected here, not bugs: the deliberate unauthorized-
    // session-access 403 this suite intentionally triggers, and the 401s
    // from `GET /api/auth/me` that fire on every unauthenticated `/login`
    // page load (the staff→instructor login switch goes through a real
    // logout, so the instructor's own `page.goto('/login')` reloads the app
    // while genuinely unauthenticated) — see fixtures.js for why that 401
    // is the app's intended mechanism, not a regression.
    diag.assertClean({
      allowedResponses: [{ urlIncludes: `/api/sessions/${foreignSessionId}`, status: 403 }],
      allowExpectedAuthFailures: true,
    });
  });
});
