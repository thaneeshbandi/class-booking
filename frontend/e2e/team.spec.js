import { expect, test } from '@playwright/test';

import { STAFF, attachDiagnostics, login, logout, uniqueLabel } from './fixtures.js';

/**
 * Staff creating staff/instructor accounts (`POST /api/users`) — not one of
 * the ten mandatory goals, added on an explicit request to make account
 * provisioning a real in-app feature. See `docs/decisions.md`.
 */
test.describe.serial('staff — Team page, creating staff/instructor accounts', () => {
  let page;
  let diag;

  // Deliberately doesn't contain "Team" — the sidebar-footer identity link
  // (`AppShell.jsx`) shows this same full name, and Playwright's default
  // role-name matching is substring/case-insensitive, so a fixture name
  // containing "Team" would false-positive-match the "Team" nav link itself.
  const instructorName = uniqueLabel('Roster Test Instructor');
  const instructorEmail = `team-instructor-${Date.now()}@example.com`;
  const staffName = uniqueLabel('Roster Test Staff');
  const staffEmail = `team-staff-${Date.now()}@example.com`;
  const newPassword = 'a-real-password-123';

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    diag = attachDiagnostics(page);
    await login(page, STAFF);
    await page.locator('nav.sidebar-nav').getByRole('link', { name: 'Team' }).click();
    await expect(page).toHaveURL(/\/team$/);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('creates a new instructor account, which appears in the table with the right role badge', async () => {
    await page.getByRole('button', { name: 'Add team member' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Full name').fill(instructorName);
    await dialog.getByLabel('Email').fill(instructorEmail);
    await dialog.getByLabel('Role').selectOption('instructor');
    await dialog.getByLabel('Temporary password').fill(newPassword);
    await dialog.getByRole('button', { name: 'Add team member', exact: true }).click();

    await expect(dialog).not.toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(instructorName) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Instructor');
  });

  test('creates a new staff account', async () => {
    await page.getByRole('button', { name: 'Add team member' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Full name').fill(staffName);
    await dialog.getByLabel('Email').fill(staffEmail);
    await dialog.getByLabel('Role').selectOption('staff');
    await dialog.getByLabel('Temporary password').fill(newPassword);
    await dialog.getByRole('button', { name: 'Add team member', exact: true }).click();

    await expect(dialog).not.toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(staffName) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Staff');
  });

  test('the new instructor account can actually log in with the password staff set for it', async () => {
    await logout(page);
    await login(page, { email: instructorEmail, password: newPassword });
    await expect(page).toHaveURL(/\/sessions$/);
    await page.locator('.sidebar-footer').click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.locator('.profile-header').getByText(instructorName)).toBeVisible();
    await logout(page);
  });

  test('a duplicate email is rejected with a friendly error and creates nothing extra', async () => {
    await login(page, STAFF);
    await page.locator('nav.sidebar-nav').getByRole('link', { name: 'Team' }).click();
    await page.getByRole('button', { name: 'Add team member' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Full name').fill('Someone Else Entirely');
    await dialog.getByLabel('Email').fill(instructorEmail);
    await dialog.getByLabel('Role').selectOption('staff');
    await dialog.getByLabel('Temporary password').fill(newPassword);
    await dialog.getByRole('button', { name: 'Add team member', exact: true }).click();

    await expect(dialog).toBeVisible();
    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText('already exists');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();

    await expect(page.getByRole('row', { name: new RegExp(instructorEmail) })).toHaveCount(1);

    diag.assertClean({
      allowedResponses: [{ urlIncludes: '/api/users', status: 409 }],
      allowExpectedAuthFailures: true,
    });
  });

  test('an instructor cannot reach the Team page or its API', async ({ browser }) => {
    const instructorPage = await browser.newPage();
    await login(instructorPage, { email: instructorEmail, password: newPassword });
    // Not in the instructor's own nav at all.
    await expect(instructorPage.locator('nav.sidebar-nav').getByRole('link', { name: 'Team' })).toHaveCount(0);
    // Direct navigation is redirected away, and the API itself denies it —
    // the nav's absence is a UX convenience, never the actual boundary.
    await instructorPage.goto('/team');
    await expect(instructorPage).toHaveURL(/\/sessions$/);
    const res = await instructorPage.request.post('http://localhost:3000/api/users', {
      data: { fullName: 'X', email: `blocked-${Date.now()}@example.com`, role: 'staff', password: newPassword },
    });
    expect(res.status()).toBe(403);
    await instructorPage.close();
  });
});
