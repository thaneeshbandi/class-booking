import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from '@playwright/test';

/**
 * Shared E2E helpers — nothing here mocks anything; every function drives
 * the real browser against the real running app.
 */

/** Reads `SEED_PASSWORD` straight from `backend/.env` rather than hardcoding
 * it, so this suite always uses whatever the running backend was actually
 * seeded with (the same source of truth the backend's own tests read via
 * `env.SEED_PASSWORD`) instead of a value that could silently drift from
 * it. */
function loadSeedPassword() {
  const envPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../backend/.env',
  );
  const content = fs.readFileSync(envPath, 'utf8');
  const match = content.match(/^SEED_PASSWORD=(.+)$/m);
  if (!match) {
    throw new Error('SEED_PASSWORD not found in backend/.env — required to run the E2E suite.');
  }
  return match[1].trim();
}

export const SEED_PASSWORD = loadSeedPassword();

/** These come straight from `backend/seeds/001_demo_data.js` and are stable
 * across a `db:reset` (the seed is deterministic) — not created by this
 * suite itself, unlike every other record these tests touch. */
export const STAFF = { email: 'ada.okonkwo@studio.test', fullName: 'Ada Okonkwo' };
export const INSTRUCTOR = { email: 'marco.silva@studio.test', fullName: 'Marco Silva' };
export const SECOND_INSTRUCTOR = { email: 'priya.raman@studio.test', fullName: 'Priya Raman' };
export const SEED_ROOM_NAME = 'Studio A';
export const SECOND_ROOM_NAME = 'Studio B';
export const SEED_CLASS_TITLE = 'Vinyasa Flow';

/** A name/email unique to this test run, matching the timestamp-suffix
 * convention the backend's own test suite already uses for exactly the same
 * reason: running the suite twice back to back (required by this
 * milestone) must never collide with the previous run's own leftover
 * records. */
export function uniqueLabel(prefix) {
  return `${prefix} ${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
}

/**
 * A far-future day offset, freshly randomized every process start (every
 * `npx playwright test` invocation gets a new Node process, hence a new
 * `Math.random()` seed) — not a fixed value the way `Date.now() + N days`
 * would be. A fixed offset collides with itself: the suite must run at
 * least twice against the same persistent database, and a second run
 * scheduling a session at the exact same day/room/instructor as the first
 * run's still-present fixture gets a real 409 scheduling conflict, not a
 * clean run. This is the same problem `uniqueLabel` solves for member/class
 * names, applied to a date instead of a string. The wide spread (700-5700
 * days out by default) keeps every call's result far past the seed's own
 * near-term demo sessions and, independently, far enough apart from any
 * other call's result in the same run that two unrelated fixture sessions
 * essentially never land on the same day by chance.
 */
export function randomFutureDayOffset(spread = 5000, floor = 700) {
  return floor + Math.floor(Math.random() * spread);
}

export async function login(page, { email, password = SEED_PASSWORD } = STAFF) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Login always lands on the app shell (dashboard for staff, sessions for
  // an instructor). Waiting for the URL to actually leave /login — not just
  // for the text "Class Booking" to appear — matters: `LoginPage` itself
  // renders an `<h1>Class Booking</h1>`, so a plain text match is satisfied
  // instantly by the login page still on screen, before the submission has
  // even resolved. That false positive let every caller race ahead of the
  // real navigation, invisible in most tests only because their next
  // assertion (`toHaveURL`) has its own retry window long enough to absorb
  // the login request's latency — until a caller with no such assertion in
  // between (this suite's own `beforeAll` helpers) hit it directly and hung
  // for a full 30s waiting on a page it was never fated to reach. A URL
  // check (rather than the sidebar's `.sidebar-brand`, which a narrow
  // viewport hides via CSS) works the same at every viewport this suite
  // uses.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

export async function logout(page) {
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/**
 * Creates a fresh staff or instructor account through the Team page
 * (`POST /api/users`), assuming `page` is already logged in as staff. Used
 * anywhere a test needs a real staff/instructor login of its own to act on
 * (e.g. resetting its password) — never the seeded `STAFF`/`INSTRUCTOR`
 * fixtures above, which every other spec file's own login calls depend on
 * keeping their original `SEED_PASSWORD`.
 */
export async function createTeamMember(page, { fullName, email, role, password }) {
  await page.locator('nav.sidebar-nav').getByRole('link', { name: 'Team' }).click();
  await expect(page).toHaveURL(/\/team$/);
  await page.getByRole('button', { name: 'Add team member' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Full name').fill(fullName);
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Role').selectOption(role);
  await dialog.getByLabel('Temporary password').fill(password);
  await dialog.getByRole('button', { name: 'Add team member', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

/**
 * Attaches console/page-error/network-failure listeners to `page` and
 * returns an object the test uses to assert nothing unexpected happened.
 * Diagnostics are collected for the whole test, not just one action, and
 * `assertClean` is called explicitly at the point the test wants to check —
 * usually at the end, after every allowed 4xx/409 from a deliberate
 * authorization/business-rule check has already been recorded in
 * `allowedResponses`.
 */
export function attachDiagnostics(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedResponses = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failedResponses.push({ url: response.url(), status: response.status() });
    }
  });

  return {
    consoleErrors,
    pageErrors,
    failedResponses,
    /**
     * `allowedResponses` is an array of `{ urlIncludes, status }` — every
     * failed response must match one of these to be considered expected (a
     * deliberate 403/409/404 the test itself triggered on purpose).
     * Anything else fails the test outright, per this milestone's own
     * instruction not to merely print diagnostics.
     *
     * Chrome's own DevTools logs *every* failed network resource load to
     * the console — regardless of whether the page's JavaScript handled it
     * gracefully — so a test that deliberately triggers an expected 4xx (an
     * unauthenticated `GET /api/auth/me`, or an authorization-boundary
     * check like a 403 for a session the caller doesn't own) would
     * otherwise see a false "console error" that was never a bug. Console
     * messages don't carry the URL in a way this can correlate back to a
     * specific `allowedResponses` entry, so the filter is coarser than the
     * network-response check below: any status code named in
     * `allowedResponses`, or 401 when `allowExpectedAuthFailures` is set,
     * is treated as expected everywhere it appears in the console. Only
     * tests that intentionally exercise one of these paths should allow it
     * — anywhere else, an unexplained 4xx is exactly the kind of real
     * regression this diagnostic exists to catch.
     */
    assertClean({ allowedResponses = [], allowExpectedAuthFailures = false } = {}) {
      const allowedStatuses = new Set(allowedResponses.map((a) => a.status));
      if (allowExpectedAuthFailures) allowedStatuses.add(401);

      const relevantConsoleErrors = consoleErrors.filter((msg) => {
        const match = /responded with a status of (\d+)/.exec(msg);
        if (!match) return true; // not a network-failure echo — always relevant
        return !allowedStatuses.has(Number(match[1]));
      });
      expect(
        relevantConsoleErrors,
        `unexpected browser console errors:\n${relevantConsoleErrors.join('\n')}`,
      ).toEqual([]);
      expect(pageErrors, `unexpected uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);

      const unexpected = failedResponses.filter((r) => {
        if (allowExpectedAuthFailures && r.status === 401) return false;
        return !allowedResponses.some((a) => r.url.includes(a.urlIncludes) && r.status === a.status);
      });
      expect(
        unexpected,
        `unexpected failed network response(s):\n${unexpected
          .map((r) => `${r.status} ${r.url}`)
          .join('\n')}`,
      ).toEqual([]);
    },
  };
}
