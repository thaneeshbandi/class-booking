import { expect, test } from '@playwright/test';

import { STAFF, login } from './fixtures.js';

/**
 * Basic responsive sanity, not pixel-perfect visual testing — desktop and a
 * narrower mobile-ish viewport, checking the app doesn't structurally break:
 * navigation stays usable, primary tables/forms don't force the whole page
 * to scroll sideways, and the primary action button on each page stays
 * reachable.
 */
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 375, height: 667 },
};

/** Below 800px, navigation lives in an off-canvas drawer (see
 * `AppShell.jsx`) — closed by default, opened by the topbar's hamburger
 * toggle, and closed again automatically on every navigation. On a wide
 * viewport the toggle doesn't exist at all (`display: none`), so opening it
 * is a no-op there and every nav link is simply clicked directly. */
async function clickNavLink(page, viewport, name, options) {
  if (viewport.width < 800) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('link', { name, ...options }).click();
}

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`responsive sanity — ${name} (${viewport.width}x${viewport.height})`, () => {
    test.use({ viewport });

    test(`dashboard renders and stays within the viewport width`, async ({ page }) => {
      await login(page, STAFF);
      await expect(page).toHaveURL(/\/dashboard$/);

      // On mobile, the nav itself is off-canvas by design — what must stay
      // reachable is the toggle that opens it, not the links directly.
      if (viewport.width < 800) {
        await expect(page.getByRole('button', { name: 'Open navigation' })).toBeInViewport();
      } else {
        await expect(page.getByRole('link', { name: 'Sessions', exact: true })).toBeVisible();
      }

      // The page itself must never force horizontal scrolling — individual
      // wide elements (tables) are allowed their own internal scroll, but
      // `document.documentElement`'s scroll width is the whole-page check.
      const overflowX = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflowX).toBeLessThanOrEqual(1); // allow 1px of sub-pixel rounding

      await page.screenshot({
        path: `test-results/screenshots/dashboard-${name}.png`,
        fullPage: true,
      });
    });

    test(`the members table and its primary action remain usable`, async ({ page }) => {
      await login(page, STAFF);
      await clickNavLink(page, viewport, 'Members');
      await expect(page).toHaveURL(/\/members$/);

      await expect(page.getByRole('button', { name: 'Add member' })).toBeInViewport();
      await expect(page.locator('table.table')).toBeVisible();

      const overflowX = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflowX).toBeLessThanOrEqual(1);

      await page.screenshot({
        path: `test-results/screenshots/members-${name}.png`,
        fullPage: true,
      });
    });

    test(`the sessions filter/create controls and nav remain reachable`, async ({ page }) => {
      await login(page, STAFF);
      await clickNavLink(page, viewport, 'Sessions', { exact: true });
      await expect(page).toHaveURL(/\/sessions$/);

      await expect(page.getByRole('button', { name: 'Create session' })).toBeInViewport();
      // The nav (an off-canvas drawer on mobile, closed again after the
      // click above) can still reach Bookings — proving the drawer reopens
      // cleanly, not just that it worked once.
      await clickNavLink(page, viewport, 'Bookings');
      await expect(page).toHaveURL(/\/bookings$/);

      await page.screenshot({
        path: `test-results/screenshots/sessions-${name}.png`,
        fullPage: true,
      });
    });

    test(`the member portal (home, sessions, bookings, profile) stays usable`, async ({ page }) => {
      await page.goto('/signup');
      await page.getByLabel('Full name').fill(`Responsive Member ${name}`);
      await page.getByLabel('Email').fill(`responsive-member-${name}-${Date.now()}@example.com`);
      await page.getByLabel('Password', { exact: true }).fill('a-real-password-123');
      await page.getByLabel('Confirm password').fill('a-real-password-123');
      await page.getByRole('button', { name: 'Sign up' }).click();
      await page.waitForURL(/\/member$/);

      await page.screenshot({ path: `test-results/screenshots/member-home-${name}.png`, fullPage: true });

      await clickNavLink(page, viewport, 'Sessions', { exact: true });
      await expect(page).toHaveURL(/\/member\/sessions$/);
      await page.screenshot({ path: `test-results/screenshots/member-sessions-${name}.png`, fullPage: true });

      await clickNavLink(page, viewport, 'My Bookings');
      await expect(page).toHaveURL(/\/member\/bookings$/);
      await page.screenshot({ path: `test-results/screenshots/member-bookings-${name}.png`, fullPage: true });

      await clickNavLink(page, viewport, 'Profile');
      await expect(page).toHaveURL(/\/profile$/);
      await expect(page.getByRole('button', { name: 'Save changes' })).toBeInViewport();
      await page.screenshot({ path: `test-results/screenshots/profile-${name}.png`, fullPage: true });

      const overflowX = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflowX).toBeLessThanOrEqual(1);
    });
  });
}
