import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Guards against a specific production regression: Vercel serves a hard
 * 404 (not index.html) for any path that isn't a static file and has no
 * matching rewrite, so a client-side route like `/dashboard` 404s on
 * direct navigation or refresh unless a SPA-fallback rewrite is present.
 * These assertions can't be exercised by the Playwright e2e suite because
 * Vite's own dev/preview servers already do SPA fallback regardless of
 * `vercel.json`, which is exactly why this regression shipped unnoticed.
 */
const configPath = fileURLToPath(new URL('../vercel.json', import.meta.url));
const config = JSON.parse(readFileSync(configPath, 'utf8'));

test('vercel.json rewrites /api/* to the Render backend', () => {
  const apiRule = config.rewrites.find((rule) => rule.source === '/api/(.*)');
  assert.ok(apiRule, 'expected an /api/(.*) rewrite');
  assert.match(apiRule.destination, /^https:\/\/.+\/api\/\$1$/);
});

test('vercel.json falls back all other paths to index.html for the SPA', () => {
  const fallback = config.rewrites.find((rule) => rule.source === '/(.*)');
  assert.ok(fallback, 'expected a catch-all rewrite for client-side routes');
  assert.equal(fallback.destination, '/index.html');
});

test('the /api rewrite is ordered before the SPA fallback', () => {
  const apiIndex = config.rewrites.findIndex((rule) => rule.source === '/api/(.*)');
  const fallbackIndex = config.rewrites.findIndex((rule) => rule.source === '/(.*)');
  assert.ok(
    apiIndex !== -1 && fallbackIndex !== -1 && apiIndex < fallbackIndex,
    'Vercel rewrites use first-match-wins, so /api/(.*) must come before the catch-all or API calls would be routed to index.html',
  );
});
