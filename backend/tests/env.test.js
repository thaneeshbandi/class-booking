import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EnvValidationError, parseEnv } from '../src/config/env.js';

/**
 * The environment schema is the first thing that runs in every entry point, so
 * a mistake here fails the server, the migrations, the seeds and the tests
 * identically. These cases pin the rules that are easy to regress.
 */

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://user:pw@localhost:5432/class_booking',
  STUDIO_TIMEZONE: 'Europe/London',
  JWT_SECRET: 'a'.repeat(32),
};

describe('environment configuration', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = parseEnv(valid);
    assert.equal(env.NODE_ENV, 'test');
    assert.equal(env.PORT, 3000);
    assert.equal(env.DATABASE_SSL, false);
  });

  it('requires DATABASE_URL to be a postgres URL', () => {
    assert.throws(
      () => parseEnv({ ...valid, DATABASE_URL: 'mysql://localhost/db' }),
      EnvValidationError,
    );
    assert.throws(
      () => parseEnv({ ...valid, DATABASE_URL: undefined }),
      EnvValidationError,
    );
    assert.doesNotThrow(() =>
      parseEnv({ ...valid, DATABASE_URL: 'postgresql://localhost/db' }),
    );
  });

  it('rejects a time zone that is not in the IANA database', () => {
    // The failure this prevents is silent: a bad zone would shift every
    // studio-day boundary rather than raising anything.
    assert.throws(
      () => parseEnv({ ...valid, STUDIO_TIMEZONE: 'Europe/Londun' }),
      EnvValidationError,
    );
    assert.throws(
      () => parseEnv({ ...valid, STUDIO_TIMEZONE: 'GMT+1' }),
      EnvValidationError,
    );
    for (const zone of ['UTC', 'America/New_York', 'Australia/Sydney']) {
      assert.doesNotThrow(() => parseEnv({ ...valid, STUDIO_TIMEZONE: zone }));
    }
  });

  it('coerces PORT and DATABASE_SSL from strings', () => {
    const env = parseEnv({ ...valid, PORT: '8080', DATABASE_SSL: 'true' });
    assert.equal(env.PORT, 8080);
    assert.equal(env.DATABASE_SSL, true);
  });

  it('requires JWT_SECRET and rejects one too short to be useful', () => {
    assert.throws(
      () => parseEnv({ ...valid, JWT_SECRET: 'short' }),
      EnvValidationError,
    );
    assert.throws(
      () => parseEnv({ ...valid, JWT_SECRET: undefined }),
      EnvValidationError,
    );
    assert.doesNotThrow(() => parseEnv(valid));
  });

  it('rejects an APP_DB_ROLE that is not a bare identifier', () => {
    assert.throws(
      () => parseEnv({ ...valid, APP_DB_ROLE: 'app"; DROP TABLE users; --' }),
      EnvValidationError,
    );
    assert.doesNotThrow(() =>
      parseEnv({ ...valid, APP_DB_ROLE: 'class_booking_app' }),
    );
  });

  it('reports every invalid variable at once, not just the first', () => {
    const error = (() => {
      try {
        parseEnv({ DATABASE_URL: 'nope', STUDIO_TIMEZONE: 'Nowhere/Here' });
      } catch (caught) {
        return caught;
      }
    })();
    assert.ok(error instanceof EnvValidationError);
    assert.equal(error.issues.length, 3);
    assert.match(error.message, /DATABASE_URL/);
    assert.match(error.message, /STUDIO_TIMEZONE/);
    assert.match(error.message, /JWT_SECRET/);
  });
});
