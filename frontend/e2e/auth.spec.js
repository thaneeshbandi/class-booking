import { expect, test } from '@playwright/test';

import { STAFF, attachDiagnostics, login, logout } from './fixtures.js';

test.describe('authentication', () => {
  test('an unauthenticated visit to a protected page redirects to /login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('login, logout, and access after logout redirects again', async ({ page }) => {
    const diag = attachDiagnostics(page);

    await login(page, STAFF);
    await expect(page).toHaveURL(/\/dashboard$/);

    await logout(page);

    // The same protected URL, after logging out, must bounce back to login —
    // proving the client actually forgot the session, not just navigated away.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);

    // This test deliberately visits a protected page while unauthenticated
    // (after logout) — the resulting 401 from GET /api/auth/me is exactly
    // how the app is supposed to learn there's no session, not a bug.
    diag.assertClean({ allowExpectedAuthFailures: true });
  });

  test('never stores the auth token in localStorage or sessionStorage', async ({ page }) => {
    await login(page, STAFF);

    const storage = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }));

    expect(Object.keys(storage.local)).toEqual([]);
    expect(Object.keys(storage.session)).toEqual([]);

    // The cookie is httpOnly, so document.cookie must not be able to read it
    // either — this is a property of the cookie itself (set server-side),
    // not something the frontend code does, but worth pinning down here
    // since it's exactly the guarantee "never store the JWT client-side"
    // depends on.
    const visibleCookie = await page.evaluate(() => document.cookie);
    expect(visibleCookie).not.toContain('session=');
  });

  test('rejects an invalid login with a visible error, and does not navigate away from /login', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(STAFF.email);
    await page.getByLabel('Password').fill('wrong-password-entirely');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});
