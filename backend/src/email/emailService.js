import nodemailer from 'nodemailer';

import { OTP_TTL_MS } from '../auth/otp.js';
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
 * The one place the reset email's actual content is decided — subject,
 * plain-text body, and an HTML equivalent, built from the same two inputs so
 * the two can never quietly drift out of sync with each other. Deliberately
 * contains nothing beyond the code itself, the app name, how long it's
 * valid, and a standard "ignore if this wasn't you" line — never the
 * account's email, name, role, or (obviously) anything about the password
 * itself.
 */
function buildOtpEmailContent(otp, ttlMinutes) {
  const subject = 'Your Class Booking password reset code';
  const text = [
    'Class Booking — password reset',
    '',
    `Your verification code is: ${otp}`,
    '',
    `This code expires in ${ttlMinutes} minutes.`,
    '',
    "If you didn't request a password reset, you can safely ignore this email — your password has not been changed.",
  ].join('\n');
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1f2b;">
      <h2 style="margin: 0 0 16px;">Class Booking</h2>
      <p style="margin: 0 0 16px;">Use this code to reset your password:</p>
      <p style="font-size: 32px; font-weight: 700; letter-spacing: 6px; margin: 0 0 16px; text-align: center; background: #f4f5f7; padding: 16px; border-radius: 8px;">${otp}</p>
      <p style="margin: 0 0 16px; color: #6b7280;">This code expires in ${ttlMinutes} minutes.</p>
      <p style="margin: 0; color: #9aa1ae; font-size: 13px;">If you didn't request a password reset, you can safely ignore this email — your password has not been changed.</p>
    </div>
  `.trim();
  return { subject, text, html };
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
async function webhookProvider({ to, subject, text, html }) {
  if (!env.EMAIL_WEBHOOK_URL) {
    throw new Error('EMAIL_WEBHOOK_URL is required when EMAIL_PROVIDER=webhook.');
  }
  const res = await fetch(env.EMAIL_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.EMAIL_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.EMAIL_WEBHOOK_TOKEN}` } : {}),
    },
    body: JSON.stringify({ to, subject, text, html }),
  });
  if (!res.ok) {
    throw new Error(`Email webhook responded with status ${res.status}.`);
  }
}

/**
 * A real, direct SMTP provider — the path that lets a deployment send actual
 * email using nothing more than credentials from any ordinary SMTP relay
 * (a Gmail account's app password, Mailtrap, Resend/Brevo's SMTP endpoint,
 * a real company mail server, etc.), with no separate relay server of its
 * own to build and host first, unlike `webhookProvider`. The transport is
 * built once, lazily, from environment variables only.
 */
let smtpTransport;
function getSmtpTransport() {
  if (smtpTransport) return smtpTransport;
  const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].filter(
    (key) => !env[key],
  );
  if (missing.length > 0) {
    throw new Error(`EMAIL_PROVIDER=smtp requires ${missing.join(', ')} to be set.`);
  }
  smtpTransport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Port 465 is implicit TLS; everything else (587, 25, ...) starts
    // plaintext and upgrades via STARTTLS, which nodemailer already does on
    // its own when `secure` is false — `SMTP_SECURE` only needs to be set
    // explicitly to override that default.
    secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return smtpTransport;
}

async function smtpProvider({ to, subject, text, html }) {
  await getSmtpTransport().sendMail({ from: env.SMTP_FROM, to, subject, text, html });
}

function selectProvider() {
  if (env.EMAIL_PROVIDER === 'smtp') return smtpProvider;
  if (env.EMAIL_PROVIDER === 'webhook') return webhookProvider;
  if (isProduction) {
    // A production deployment with no real provider configured is a
    // deployment mistake, not something to silently fall back to console
    // logging for — that fallback is exactly the "OTP visible somewhere
    // production can see it" outcome this must never allow.
    throw new Error(
      'EMAIL_PROVIDER must be set to a real provider ("smtp" or "webhook") in production.',
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
  const ttlMinutes = Math.round(OTP_TTL_MS / 60_000);
  const { subject, text, html } = buildOtpEmailContent(otp, ttlMinutes);
  await getProvider()({ to, subject, text, html });
}
