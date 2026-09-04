import { expect, test } from '@playwright/test';

import { INSTRUCTOR, STAFF, createTeamMember, login, logout } from './fixtures.js';

/**
 * Forgot password (email OTP) and every role's profile page. The OTP is
 * retrieved through the dev-only `GET /api/auth/forgot-password/dev/last-otp`
 * route (`routes/auth.js`) — registered only when `NODE_ENV !== 'production'`
 * — standing in for reading a real inbox; this is the "test/dev email
 * adapter" the milestone calls for, since Playwright runs as a separate
 * process from the backend and cannot import its in-memory `sentEmails`
 * store the way the backend's own `node --test` suite does.
 */

// The frontend dev server (baseURL for `page.goto`) has no API proxy — the
// real app always calls the backend's own absolute origin directly (see
// `vite.config.js` and `api/client.js`'s `VITE_API_BASE_URL`) — so this,
// too, must hit the backend directly rather than a path relative to
// `baseURL`.
const BACKEND_ORIGIN = 'http://localhost:3000';

async function fetchDevOtp(page, email) {
  const res = await page.request.get(
    `${BACKEND_ORIGIN}/api/auth/forgot-password/dev/last-otp?email=${encodeURIComponent(email)}`,
  );
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.otp;
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

test.describe('forgot password — email OTP', () => {
  test('the login page links to it', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });

  test('full flow: request code -> verify -> reset -> log in with the new password', async ({ page }) => {
    const email = `otp-flow-${Date.now()}@example.com`;
    await signup(page, { fullName: 'Otp Flow Member', email });
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send verification code' }).click();
    await expect(page.getByLabel('Verification code')).toBeVisible();

    const otp = await fetchDevOtp(page, email);
    await page.getByLabel('Verification code').fill(otp);
    await page.getByRole('button', { name: 'Verify code' }).click();

    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
    await page.getByLabel('New password', { exact: true }).fill('post-reset-password-789');
    await page.getByLabel('Confirm new password').fill('post-reset-password-789');
    await page.getByRole('button', { name: 'Reset password' }).click();

    await expect(page.getByText('Password reset successfully. You can now sign in with your new password.')).toBeVisible();
    await page.getByRole('link', { name: 'Go to sign in' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await login(page, { email, password: 'post-reset-password-789' });
    await expect(page).toHaveURL(/\/member$/);
  });

  test('an incorrect code shows a polished, visible error and does not advance', async ({ page }) => {
    const email = `otp-wrong-${Date.now()}@example.com`;
    await signup(page, { fullName: 'Otp Wrong Member', email });
    await page.getByRole('button', { name: 'Log out' }).click();

    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send verification code' }).click();
    // Waits for the OTP request itself to resolve (the code-entry step only
    // renders once it has) before reaching for the dev OTP out of band —
    // without this, the API call below can race the one the click just
    // triggered.
    await expect(page.getByLabel('Verification code')).toBeVisible();

    const otp = await fetchDevOtp(page, email);
    const wrong = otp === '000000' ? '111111' : '000000';
    await page.getByLabel('Verification code').fill(wrong);
    await page.getByRole('button', { name: 'Verify code' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText(/^400:/);
    await expect(page.getByLabel('New password')).toHaveCount(0);
  });

  test('the request step never reveals whether the email has an account', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill('no-such-account-at-all@example.com');
    await page.getByRole('button', { name: 'Send verification code' }).click();
    // The UI simply advances to the OTP-entry step either way — there is no
    // branch in the frontend that could show a different outcome for an
    // unknown email, matching the backend's identical generic response.
    await expect(page.getByLabel('Verification code')).toBeVisible();
  });

  test('the OTP step shows expiry information and a working resend cooldown', async ({ page }) => {
    const email = `otp-ux-${Date.now()}@example.com`;
    await signup(page, { fullName: 'Otp Ux Member', email });
    await page.getByRole('button', { name: 'Log out' }).click();

    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send verification code' }).click();
    await expect(page.getByLabel('Verification code')).toBeVisible();

    // Expiry copy, driven by the backend's own `expiresInMinutes` (never a
    // second, hand-typed number on the frontend) — see `docs/decisions.md`.
    await expect(page.getByText('This code expires in 10 minutes.')).toBeVisible();

    // The resend cooldown starts the moment a code is sent — including the
    // very first send, not just a subsequent resend — so the button is
    // already disabled with a visible countdown as soon as this step
    // renders. A deterministic, immediate UI check, not a real 30-second
    // wait for the cooldown to actually elapse.
    const resend = page.getByRole('button', { name: /^Resend code/ });
    await expect(resend).toBeDisabled();
    await expect(resend).toHaveText(/Resend code \(\d+s\)/);
  });

  test('two wrong codes in a row surfaces a "request a new code" nudge, without ever confirming why', async ({ page }) => {
    const email = `otp-nudge-${Date.now()}@example.com`;
    await signup(page, { fullName: 'Otp Nudge Member', email });
    await page.getByRole('button', { name: 'Log out' }).click();

    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send verification code' }).click();
    await expect(page.getByLabel('Verification code')).toBeVisible();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.getByLabel('Verification code').fill('000000');
      await page.getByRole('button', { name: 'Verify code' }).click();
      await expect(page.getByRole('alert')).toBeVisible();
    }

    // A purely client-side nudge, distinct from — and shown alongside — the
    // backend's own unchanged generic error message.
    await expect(page.getByRole('button', { name: 'request a new code' })).toBeVisible();
  });

  test('an already-used code is rejected the same generic way on a second attempt, and "Use a different email" never leaves the user stuck', async ({ page }) => {
    const email = `otp-reuse-${Date.now()}@example.com`;
    await signup(page, { fullName: 'Otp Reuse Member', email });
    await page.getByRole('button', { name: 'Log out' }).click();

    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send verification code' }).click();
    await expect(page.getByLabel('Verification code')).toBeVisible();

    const otp = await fetchDevOtp(page, email);
    await page.getByLabel('Verification code').fill(otp);
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
    await page.getByLabel('New password', { exact: true }).fill('reuse-guard-password-1');
    await page.getByLabel('Confirm new password').fill('reuse-guard-password-1');
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByText('Password reset successfully. You can now sign in with your new password.')).toBeVisible();

    // Start a second forgot-password attempt and try the now-consumed code.
    await page.getByRole('link', { name: 'Go to sign in' }).click();
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send verification code' }).click();
    await expect(page.getByLabel('Verification code')).toBeVisible();
    await page.getByLabel('Verification code').fill(otp);
    await page.getByRole('button', { name: 'Verify code' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('invalid or has expired');
    await expect(page.getByLabel('New password')).toHaveCount(0);

    // Never stranded: a working way back to the start of the flow.
    await page.getByRole('button', { name: 'Use a different email' }).click();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Verification code')).toHaveCount(0);
  });

  test('a password/confirmation mismatch is caught client-side, before any reset request is made', async ({ page }) => {
    const email = `otp-mismatch-${Date.now()}@example.com`;
    await signup(page, { fullName: 'Otp Mismatch Member', email });
    await page.getByRole('button', { name: 'Log out' }).click();

    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send verification code' }).click();
    await expect(page.getByLabel('Verification code')).toBeVisible();

    const otp = await fetchDevOtp(page, email);
    await page.getByLabel('Verification code').fill(otp);
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();

    await page.getByLabel('New password', { exact: true }).fill('mismatch-password-1');
    await page.getByLabel('Confirm new password').fill('a-different-password-2');
    await expect(page.getByText('New password and confirmation do not match.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset password' })).toBeDisabled();
  });
});

test.describe('forgot password — staff and instructor roles', () => {
  const instructorEmail = `forgot-instructor-${Date.now()}@example.com`;
  const instructorName = 'Forgot Flow Instructor';
  const staffEmail = `forgot-staff-${Date.now()}@example.com`;
  const staffName = 'Forgot Flow Staff';
  const tempPassword = 'a-real-password-123';

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, STAFF);
    await createTeamMember(page, { fullName: instructorName, email: instructorEmail, role: 'instructor', password: tempPassword });
    await createTeamMember(page, { fullName: staffName, email: staffEmail, role: 'staff', password: tempPassword });
    await logout(page);
    await page.close();
  });

  async function resetPasswordThroughUi(page, email, newPassword) {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send verification code' }).click();
    await expect(page.getByLabel('Verification code')).toBeVisible();

    const otp = await fetchDevOtp(page, email);
    await page.getByLabel('Verification code').fill(otp);
    await page.getByRole('button', { name: 'Verify code' }).click();

    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
    await page.getByLabel('New password', { exact: true }).fill(newPassword);
    await page.getByLabel('Confirm new password').fill(newPassword);
    await page.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByText('Password reset successfully. You can now sign in with your new password.')).toBeVisible();
    await page.getByRole('link', { name: 'Go to sign in' }).click();
    await expect(page).toHaveURL(/\/login$/);
  }

  test('an instructor account: reset via forgot-password, then log in with the new password', async ({ page }) => {
    const newPassword = 'instructor-reset-password-1';
    await resetPasswordThroughUi(page, instructorEmail, newPassword);

    await login(page, { email: instructorEmail, password: newPassword });
    await expect(page).toHaveURL(/\/sessions$/);
    await page.locator('.sidebar-footer').click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.locator('.profile-header').getByText(instructorName)).toBeVisible();
    await expect(page.locator('.profile-header').getByText('Instructor', { exact: true })).toBeVisible();
  });

  test('a staff account: reset via forgot-password, then log in with the new password', async ({ page }) => {
    const newPassword = 'staff-reset-password-1';
    await resetPasswordThroughUi(page, staffEmail, newPassword);

    await login(page, { email: staffEmail, password: newPassword });
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.locator('.sidebar-footer').click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.locator('.profile-header').getByText(staffName)).toBeVisible();
    await expect(page.locator('.profile-header').getByText('Staff', { exact: true })).toBeVisible();
  });
});

test.describe('profile — every role', () => {
  test('a member can view and edit their own profile and change their password', async ({ page }) => {
    const email = `profile-member-${Date.now()}@example.com`;
    await signup(page, { fullName: 'Profile Member', email });
    await page.locator('nav.sidebar-nav').getByRole('link', { name: 'Profile' }).click();

    await expect(page.locator('.profile-header').getByText('Profile Member')).toBeVisible();
    await expect(page.locator('.profile-header').getByText('Member', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveValue(email);
  });

  test('a staff account can view its own profile — no role field is ever editable', async ({ page }) => {
    await login(page, STAFF);
    await page.locator('nav.sidebar-nav').getByRole('link', { name: 'Profile' }).click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.locator('.profile-header').getByText(STAFF.fullName)).toBeVisible();
    await expect(page.locator('.profile-header').getByText('Staff', { exact: true })).toBeVisible();
    await expect(page.locator('.profile-account-details').getByText('Staff', { exact: true })).toBeVisible();
    // The account card shows the role as plain text, never a <select>.
    await expect(page.locator('.profile-account-details select')).toHaveCount(0);
  });

  test('an instructor account can view its own profile', async ({ page }) => {
    await login(page, INSTRUCTOR);
    await page.locator('nav.sidebar-nav').getByRole('link', { name: 'Profile' }).click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.locator('.profile-header').getByText(INSTRUCTOR.fullName)).toBeVisible();
    await expect(page.locator('.profile-header').getByText('Instructor', { exact: true })).toBeVisible();
  });

  test('a member cannot open another user\'s profile by any URL — there is no such route', async ({ page }) => {
    const email = `no-other-profile-${Date.now()}@example.com`;
    await signup(page, { fullName: 'Own Profile Only', email });
    // `/profile` always resolves to the caller's own account server-side
    // (`GET /api/profile` reads `req.user.id`, never a URL parameter) — no
    // route exists that takes a target user id at all.
    await page.locator('nav.sidebar-nav').getByRole('link', { name: 'Profile' }).click();
    await expect(page.getByLabel('Email')).toHaveValue(email);
  });
});

// The sidebar's bottom-left identity control (avatar + name) is a second,
// separate way into the exact same `/profile` route the nav link above
// already exercises — not a different page. Each test below clicks that
// control directly (rather than the "Profile" nav link) and confirms it
// lands on `/profile` showing that same signed-in user's own identity.
test.describe('profile — sidebar identity control (bottom-left)', () => {
  test('a member: clicking the bottom-left identity control opens their own profile', async ({ page }) => {
    const email = `identity-member-${Date.now()}@example.com`;
    await signup(page, { fullName: 'Identity Member', email });
    await page.locator('.sidebar-footer').click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.locator('.profile-header').getByText('Identity Member')).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveValue(email);
  });

  test('staff: clicking the bottom-left identity control opens their own profile', async ({ page }) => {
    await login(page, STAFF);
    await page.locator('.sidebar-footer').click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.locator('.profile-header').getByText(STAFF.fullName)).toBeVisible();
    await expect(page.locator('.profile-header').getByText('Staff', { exact: true })).toBeVisible();
  });

  test('instructor: clicking the bottom-left identity control opens their own profile', async ({ page }) => {
    await login(page, INSTRUCTOR);
    await page.locator('.sidebar-footer').click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.locator('.profile-header').getByText(INSTRUCTOR.fullName)).toBeVisible();
    await expect(page.locator('.profile-header').getByText('Instructor', { exact: true })).toBeVisible();
  });

  test('the bottom-left identity control uses real link semantics, not a clickable div', async ({ page }) => {
    await login(page, STAFF);
    const control = page.locator('.sidebar-footer');
    await expect(control).toHaveAttribute('href', '/profile');
    // A real anchor is keyboard-focusable and reachable via role queries —
    // a clickable `<div>` would satisfy neither.
    await expect(page.getByRole('link', { name: STAFF.fullName })).toHaveAttribute('href', '/profile');
    // Logout — the other identity control, in the topbar — is untouched by
    // this change and still works from the same page.
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});
