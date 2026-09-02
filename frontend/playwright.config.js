import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end coverage against the *real* running application — the actual
 * Vite dev server talking to the actual Express backend talking to the
 * actual PostgreSQL database. Nothing here mocks an API response; every
 * assertion is only ever true because the real backend actually did what
 * the UI claims it did.
 *
 * `webServer` starts both halves itself (`reuseExistingServer` locally, so
 * an already-running `npm run dev`/`npm start` from manual testing isn't
 * killed and restarted) and waits for each to answer before tests run.
 * `workers: 1` is deliberate, not a performance default: every test creates
 * real rows in one shared Postgres database (uniquely named, so parallel
 * runs wouldn't collide on identity, but the auth flow tests log out/in as
 * different users against the same browser context pattern used elsewhere,
 * and running everything against one live backend one spec at a time keeps
 * failures attributable to a single, deterministic cause rather than
 * cross-test interference).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npm start',
      cwd: '../backend',
      url: 'http://localhost:3000/health',
      reuseExistingServer: true,
      timeout: 20_000,
    },
    {
      command: 'npm run dev',
      cwd: '.',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 20_000,
    },
  ],
});
