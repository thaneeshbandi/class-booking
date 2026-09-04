import { expect, test } from '@playwright/test';

import { STAFF, attachDiagnostics, login, uniqueLabel } from './fixtures.js';

function isoDate(daysFromNow) {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Staff cannot create (or edit into) two member records sharing an email —
 * enforced server-side by `members_email_unique` (migration 014), not just
 * a frontend check. See `docs/decisions.md` for why this reverses the
 * project's earlier "one household email across members" design.
 */
test.describe.serial('staff — duplicate member email is rejected', () => {
  let page;
  let diag;

  const memberAName = uniqueLabel('Dup Email Member A');
  const memberBName = uniqueLabel('Dup Email Member B');
  const email = `dup-email-${Date.now()}@example.com`;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    diag = attachDiagnostics(page);
    await login(page, STAFF);
    await page.getByRole('link', { name: 'Members' }).click();
    await expect(page).toHaveURL(/\/members$/);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('creating a member with a unique email succeeds', async () => {
    await page.getByRole('button', { name: 'Add member' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Full name').fill(memberAName);
    await dialog.getByLabel('Email').fill(email);
    await dialog.getByLabel('Membership expires on').fill(isoDate(365));
    await dialog.getByRole('button', { name: 'Add member', exact: true }).click();

    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(memberAName) })).toBeVisible();
  });

  test('a second member with the exact same email shows a friendly error and creates nothing', async () => {
    await page.getByRole('button', { name: 'Add member' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Full name').fill(memberBName);
    await dialog.getByLabel('Email').fill(email);
    await dialog.getByLabel('Membership expires on').fill(isoDate(200));
    await dialog.getByRole('button', { name: 'Add member', exact: true }).click();

    // Dialog stays open, form values are retained, and a clean friendly
    // error is shown — never a raw DB error or a blank 500.
    await expect(dialog).toBeVisible();
    const alert = dialog.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('already exists');
    await expect(alert).not.toContainText(/23505|constraint|SQL/i);
    await expect(dialog.getByLabel('Full name')).toHaveValue(memberBName);
    await expect(dialog.getByLabel('Email')).toHaveValue(email);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();

    // Exactly one row for this email — the rejected attempt created nothing.
    await expect(page.getByRole('row', { name: new RegExp(email) })).toHaveCount(1);
    await expect(page.getByRole('row', { name: new RegExp(memberBName) })).toHaveCount(0);
  });

  test('a duplicate with different casing and surrounding whitespace is rejected the same way', async () => {
    const shouted = `  ${email.toUpperCase()}  `;
    await page.getByRole('button', { name: 'Add member' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Full name').fill(uniqueLabel('Dup Email Member C'));
    await dialog.getByLabel('Email').fill(shouted);
    await dialog.getByLabel('Membership expires on').fill(isoDate(100));
    await dialog.getByRole('button', { name: 'Add member', exact: true }).click();

    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('already exists');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();

    await expect(page.getByRole('row', { name: new RegExp(email) })).toHaveCount(1);
  });

  test('editing an unrelated member to an existing email is rejected, and the original member is unchanged', async () => {
    await page.getByRole('button', { name: 'Add member' }).click();
    const createDialog = page.getByRole('dialog');
    const otherEmail = `dup-email-other-${Date.now()}@example.com`;
    await createDialog.getByLabel('Full name').fill(memberBName);
    await createDialog.getByLabel('Email').fill(otherEmail);
    await createDialog.getByLabel('Membership expires on').fill(isoDate(200));
    await createDialog.getByRole('button', { name: 'Add member', exact: true }).click();
    await expect(createDialog).not.toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(memberBName) });
    await row.getByRole('button', { name: 'Edit' }).click();
    const editDialog = page.getByRole('dialog');
    await expect(editDialog.getByRole('heading', { name: 'Edit member' })).toBeVisible();
    await editDialog.getByLabel('Email').fill(email);
    await editDialog.getByRole('button', { name: 'Save changes' }).click();

    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByRole('alert')).toContainText('already exists');
    await editDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(editDialog).not.toBeVisible();

    // Member B still has its own original email — the rejected edit never
    // took effect.
    await expect(page.getByRole('row', { name: new RegExp(memberBName) })).toContainText(otherEmail);
    // Member A (the original owner of `email`) is untouched.
    await expect(page.getByRole('row', { name: new RegExp(memberAName) })).toContainText(email);

    diag.assertClean({
      allowedResponses: [{ urlIncludes: '/api/members', status: 409 }],
      allowExpectedAuthFailures: true,
    });
  });
});
