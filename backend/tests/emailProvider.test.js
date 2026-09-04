import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { env } from '../src/config/env.js';
import { buildOtpEmailContent, resendProvider, selectProvider, sendOtpEmail, sentEmails } from '../src/email/emailService.js';

/**
 * `src/email/emailService.js`'s provider abstraction, tested directly rather
 * than through `sendOtpEmail`'s own lazy `getProvider()` cache: that cache
 * is a module-level `let provider`, resolved once and memoized for the rest
 * of the process — and by the time this file runs, dozens of earlier tests
 * (`tests/forgotPassword.test.js` and others) have already called
 * `sendOtpEmail`, locking it to the console/dev provider for the rest of
 * this suite's run. `selectProvider` and `resendProvider` are exported
 * specifically so provider *selection* and *request-building* can be tested
 * on their own, independent of that cache — see each export's own comment
 * in `emailService.js`.
 *
 * `env` is a plain, mutable object (not frozen) — genuinely poking at
 * `env.RESEND_API_KEY` etc. for one test and restoring it immediately after
 * is how this file exercises each provider's own configuration without a
 * mocking library. `fetch` is mocked the same direct way: save the real
 * global, replace it, restore it — no real network call, matching this
 * milestone's own instruction not to depend on a real external email
 * service in the permanent test suite.
 */

const ENV_KEYS = ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'RESEND_FROM'];

async function withEnv(overrides, fn) {
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, env[key]]));
  Object.assign(env, overrides);
  try {
    await fn();
  } finally {
    Object.assign(env, original);
  }
}

function mockFetch(impl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return impl(url, options);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

describe('selectProvider', () => {
  it('resolves to the Resend provider when EMAIL_PROVIDER=resend', async () => {
    await withEnv({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: undefined, RESEND_FROM: undefined }, async () => {
      const provider = selectProvider();
      await assert.rejects(
        () => provider({ to: 'x@example.test', subject: 's', text: 't', html: 'h' }),
        /RESEND_API_KEY and RESEND_FROM/,
        'the resend provider — not some other one — was selected and invoked',
      );
    });
  });

  it('resolves to the SMTP provider when EMAIL_PROVIDER=smtp', async () => {
    await withEnv({ EMAIL_PROVIDER: 'smtp' }, async () => {
      const provider = selectProvider();
      await assert.rejects(
        () => provider({ to: 'x@example.test', subject: 's', text: 't', html: 'h' }),
        /EMAIL_PROVIDER=smtp requires/,
      );
    });
  });

  it('resolves to the webhook provider when EMAIL_PROVIDER=webhook', async () => {
    await withEnv({ EMAIL_PROVIDER: 'webhook' }, async () => {
      const provider = selectProvider();
      await assert.rejects(
        () => provider({ to: 'x@example.test', subject: 's', text: 't', html: 'h' }),
        /EMAIL_WEBHOOK_URL is required/,
      );
    });
  });

  it('resolves to the console/dev provider when EMAIL_PROVIDER is unset (this test process is never production)', async () => {
    await withEnv({ EMAIL_PROVIDER: undefined }, async () => {
      const provider = selectProvider();
      const before = sentEmails.length;
      await provider({ to: 'select-console@example.test', subject: 'Select Console', text: 'body' });
      assert.equal(sentEmails.length, before + 1);
      assert.equal(sentEmails.at(-1).to, 'select-console@example.test');
    });
  });
});

describe('resendProvider', () => {
  it('sends the correct HTTPS request: URL, Authorization header, and a JSON body with recipient/subject/text/html', async () => {
    const mock = mockFetch(() => ({ ok: true, status: 200 }));
    try {
      await withEnv({ RESEND_API_KEY: 'test-key-abc123', RESEND_FROM: 'Class Booking <reset@example.test>' }, async () => {
        await resendProvider({ to: 'recipient@example.test', subject: 'Your code', text: 'plain body', html: '<p>html body</p>' });
      });

      assert.equal(mock.calls.length, 1);
      const [{ url, options }] = mock.calls;
      assert.equal(url, 'https://api.resend.com/emails');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(options.headers.Authorization, 'Bearer test-key-abc123');

      const body = JSON.parse(options.body);
      assert.deepEqual(body, {
        from: 'Class Booking <reset@example.test>',
        to: 'recipient@example.test',
        subject: 'Your code',
        text: 'plain body',
        html: '<p>html body</p>',
      });
    } finally {
      mock.restore();
    }
  });

  it('throws a clean, non-leaking error when Resend responds with a non-2xx status', async () => {
    const mock = mockFetch(() => ({ ok: false, status: 401 }));
    try {
      await withEnv({ RESEND_API_KEY: 'test-key-should-not-leak', RESEND_FROM: 'reset@example.test' }, async () => {
        await assert.rejects(
          () => resendProvider({ to: 'x@example.test', subject: 's', text: 'plain-with-000000-otp', html: 'h' }),
          (error) => {
            assert.equal(error.message, 'Resend responded with status 401.');
            assert.doesNotMatch(error.message, /test-key-should-not-leak/, 'the API key must never appear in a thrown error');
            assert.doesNotMatch(error.message, /000000/, 'the OTP/request content must never appear in a thrown error');
            return true;
          },
        );
      });
    } finally {
      mock.restore();
    }
  });

  it('refuses to even attempt a request when RESEND_API_KEY or RESEND_FROM is missing', async () => {
    const mock = mockFetch(() => {
      throw new Error('fetch must not be called when required config is missing');
    });
    try {
      await withEnv({ RESEND_API_KEY: undefined, RESEND_FROM: undefined }, async () => {
        await assert.rejects(
          () => resendProvider({ to: 'x@example.test', subject: 's', text: 't', html: 'h' }),
          /RESEND_API_KEY and RESEND_FROM/,
        );
      });
      assert.equal(mock.calls.length, 0, 'no network call was ever attempted');
    } finally {
      mock.restore();
    }
  });

  it("a provider-level failure never breaks sendOtpEmail's own caller's usual error-handling shape", async () => {
    // Mirrors exactly how routes/auth.js consumes a rejected `sendOtpEmail`
    // (`.catch((error) => console.error(...))`) — proves a Resend failure
    // still resolves to a plain `Error` with a safe `.message`, not
    // something that would need special-casing at the call site.
    const mock = mockFetch(() => ({ ok: false, status: 500 }));
    try {
      await withEnv({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', RESEND_FROM: 'reset@example.test' }, async () => {
        // Bypasses the `getProvider()` cache deliberately (see file header)
        // by calling `selectProvider()` fresh rather than `sendOtpEmail`.
        const provider = selectProvider();
        const caught = await provider({ to: 'x@example.test', subject: 's', text: 't', html: 'h' }).catch((error) => error);
        assert.ok(caught instanceof Error);
        assert.equal(caught.message, 'Resend responded with status 500.');
      });
    } finally {
      mock.restore();
    }
  });
});

describe('buildOtpEmailContent', () => {
  it('includes the OTP and the expiry in both the plain-text and HTML bodies', () => {
    const { subject, text, html } = buildOtpEmailContent('654321', 10);
    assert.match(subject, /Class Booking/);
    assert.match(text, /654321/);
    assert.match(text, /10 minutes/);
    assert.match(html, /654321/);
    assert.match(html, /10 minutes/);
    assert.match(text, /if you didn't request/i);
  });

  it('never mentions the account password itself', () => {
    const { text, html } = buildOtpEmailContent('111111', 10);
    assert.doesNotMatch(text, /\bpassword is\b/i);
    assert.doesNotMatch(html, /\bpassword is\b/i);
  });
});

describe('sendOtpEmail (existing dev/test path, unchanged)', () => {
  it('still records a sent email for the console/dev provider — proves this milestone did not disturb the existing test email path', async () => {
    const before = sentEmails.length;
    await sendOtpEmail('unchanged-path@example.test', '222222');
    assert.equal(sentEmails.length, before + 1);
    assert.match(sentEmails.at(-1).text, /222222/);
  });
});
