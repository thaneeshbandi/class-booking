import { env, isProduction } from '../config/env.js';

/**
 * A small, swappable email-provider abstraction — nothing in this codebase
 * had one before this milestone (there was no feature that needed to send
 * email). Every caller goes through `sendOtpEmail` below; which provider
 * actually delivers the message is chosen once, from environment variables,
 * never hardcoded.
 *
 * `sentEmails` is an in-memory, process-local record of what the dev/console
 * provider "sent". It exists for exactly one reason: automated tests must be
 * able to retrieve a generated OTP without making a real email call (backend
 * `node --test` runs in the same process as the app under test — see
 * `tests/helpers/httpClient.js` — and can import this array directly;
 * Playwright runs as a separate process and instead uses the dev-only
 * `GET /api/auth/forgot-password/dev/last-otp` route in `routes/auth.js`,
 * which is only ever registered when `!isProduction`). It is bounded and
 * reset per process; nothing about it is reachable over HTTP except that one
 * explicitly non-production route.
 */
export const sentEmails = [];
const MAX_SENT_EMAILS = 200;

function recordSentEmail(entry) {
  sentEmails.push({ ...entry, sentAt: new Date().toISOString() });
  if (sentEmails.length > MAX_SENT_EMAILS) sentEmails.shift();
}

/**
 * Dev/test provider: writes a clearly-labeled line to the server console and
 * records the message for local/test retrieval. Selected automatically
 * whenever `EMAIL_PROVIDER` is unset and `NODE_ENV !== 'production'` — never
 * selectable in production (see `selectProvider` below), so a raw OTP can
 * never end up in a production log through this path.
 */
async function consoleProvider({ to, subject, text }) {
  console.log(`[dev email] to=${to} subject="${subject}"\n${text}`);
  recordSentEmail({ to, subject, text });
}

/**
 * A minimal "real" provider: POSTs the message to an operator-configured
 * transactional-email endpoint (e.g. an internal relay in front of
 * SendGrid/SES/Postmark/etc.), authenticated with a bearer token — both read
 * from environment variables only, never hardcoded. This is the "swappable"
 * half of the abstraction: adding a genuinely different provider (a vendor
 * SDK, say) means adding one function here and one branch in
 * `selectProvider`, never touching `sendOtpEmail` or any caller.
 */
async function webhookProvider({ to, subject, text }) {
  if (!env.EMAIL_WEBHOOK_URL) {
    throw new Error('EMAIL_WEBHOOK_URL is required when EMAIL_PROVIDER=webhook.');
  }
  const res = await fetch(env.EMAIL_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.EMAIL_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.EMAIL_WEBHOOK_TOKEN}` } : {}),
    },
    body: JSON.stringify({ to, subject, text }),
  });
  if (!res.ok) {
    throw new Error(`Email webhook responded with status ${res.status}.`);
  }
}

function selectProvider() {
  if (env.EMAIL_PROVIDER === 'webhook') return webhookProvider;
  if (isProduction) {
    // A production deployment with no real provider configured is a
    // deployment mistake, not something to silently fall back to console
    // logging for — that fallback is exactly the "OTP visible somewhere
    // production can see it" outcome this must never allow.
    throw new Error(
      'EMAIL_PROVIDER must be set to a real provider (currently: "webhook") in production.',
    );
  }
  return consoleProvider;
}

let provider;
function getProvider() {
  if (!provider) provider = selectProvider();
  return provider;
}

export async function sendOtpEmail(to, otp) {
  const subject = 'Your password reset code';
  const text = `Your verification code is ${otp}. It expires in 10 minutes. If you didn't request a password reset, you can safely ignore this email.`;
  await getProvider()({ to, subject, text });
}
