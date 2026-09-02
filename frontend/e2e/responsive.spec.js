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

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`responsive sanity — ${name} (${viewport.width}x${viewport.height})`, () => {
    test.use({ viewport });

    test(`dashboard renders and stays within the viewport width`, async ({ page }) => {
      await login(page, STAFF);
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(page.getByRole('link', { name: 'Sessions', exact: true })).toBeVisible();

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
      await page.getByRole('link', { name: 'Members' }).click();
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
      await page.getByRole('link', { name: 'Sessions', exact: true }).click();
      await expect(page).toHaveURL(/\/sessions$/);

      await expect(page.getByRole('button', { name: 'Create session' })).toBeInViewport();
      // The sidebar nav (which collapses to something narrower on mobile,
      // but must still exist and remain clickable) can still reach Bookings.
      await page.getByRole('link', { name: 'Bookings' }).click();
      await expect(page).toHaveURL(/\/bookings$/);

      await page.screenshot({
        path: `test-results/screenshots/sessions-${name}.png`,
        fullPage: true,
      });
    });
  });
}
