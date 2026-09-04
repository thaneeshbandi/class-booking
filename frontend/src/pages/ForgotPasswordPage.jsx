import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { requestPasswordReset, resetPassword, verifyPasswordResetOtp } from '../api/forgotPassword.js';
import { AuthLayout } from '../components/AuthLayout.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorBanner, FieldError } from '../components/States.jsx';

/**
 * Forgot password — email OTP, in three steps (request, verify, reset).
 * `POST /forgot-password/request` always returns the same generic message
 * regardless of whether the email has an account, so this page never learns
 * — and can never show — whether an email is registered; see
 * `docs/decisions.md` for why that's a deliberate anti-enumeration measure,
 * not a missing detail.
 *
 * `expiresInMinutes`/`cooldownSeconds` come back on every `/request`
 * response (a fixed constant either way — see the backend route's own
 * comment on why that doesn't weaken anti-enumeration) so this page's copy
 * is never a second, hand-typed number that could drift from the real
 * server-side value.
 *
 * A wrong-code counter here is purely cosmetic client-side state — it only
 * ever changes which *extra* hint is shown alongside the backend's own
 * message, never replaces it, and the backend's response is identical
 * whether a code is wrong, expired, or has run out of attempts (see
 * `docs/decisions.md`) — so this never asks the server to confirm anything
 * it wouldn't already say.
 */
export function ForgotPasswordPage() {
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [resetToken, setResetToken] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [expiresInMinutes, setExpiresInMinutes] = useState(10);
  const [cooldownSeconds, setCooldownSeconds] = useState(30);
  const [resendAvailableAt, setResendAvailableAt] = useState(0);
  const [resendCountdown, setResendCountdown] = useState(0);
  const [failedAttempts, setFailedAttempts] = useState(0);

  useEffect(() => {
    if (step !== 'otp') return undefined;
    const tick = () => {
      setResendCountdown(Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1000)));
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [step, resendAvailableAt]);

  function resetFlow() {
    setStep('email');
    setEmail('');
    setOtp('');
    setResetToken(null);
    setNewPassword('');
    setConfirmNewPassword('');
    setError(null);
    setFailedAttempts(0);
    setResendAvailableAt(0);
  }

  async function handleRequestSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await requestPasswordReset(email);
      setExpiresInMinutes(result.expiresInMinutes ?? 10);
      setCooldownSeconds(result.cooldownSeconds ?? 30);
      setResendAvailableAt(Date.now() + (result.cooldownSeconds ?? 30) * 1000);
      setFailedAttempts(0);
      setStep('otp');
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifySubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await verifyPasswordResetOtp(email, otp);
      setResetToken(result.resetToken);
      setStep('reset');
    } catch (err) {
      setError(err);
      setFailedAttempts((count) => count + 1);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResendOtp() {
    setError(null);
    setSubmitting(true);
    try {
      const result = await requestPasswordReset(email);
      setResendAvailableAt(Date.now() + (result.cooldownSeconds ?? cooldownSeconds) * 1000);
      setFailedAttempts(0);
      setOtp('');
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResetSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await resetPassword(resetToken, newPassword, confirmNewPassword);
      setStep('done');
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const mismatch = confirmNewPassword.length > 0 && newPassword !== confirmNewPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < 8;
  // The reset step's own resetToken can go stale (its own short TTL expires,
  // or a duplicate tab already consumed it) — a 400 here is the backend's
  // only way to say so, and this page's job is to make sure that never
  // leaves the user stuck looking at a dead form with no way forward.
  const resetTokenLikelyInvalid = step === 'reset' && error?.status === 400;

  if (step === 'done') {
    return (
      <AuthLayout title="Password reset" subtitle="You can now sign in with your new password.">
        <div className="state-block state-success" role="status">
          <Icon name="check" size={16} />
          Password reset successfully. You can now sign in with your new password.
        </div>
        <Link to="/login" className="btn btn-primary btn-block">
          Go to sign in
        </Link>
      </AuthLayout>
    );
  }

  if (step === 'otp') {
    return (
      <AuthLayout title="Check your email" subtitle={`Enter the 6-digit code we sent to ${email}.`}>
        <form onSubmit={handleVerifySubmit} noValidate>
          <ErrorBanner error={error} />
          {failedAttempts >= 2 ? (
            <p className="form-hint">
              Too many attempts? You can{' '}
              <button type="button" className="link-button" onClick={handleResendOtp} disabled={submitting}>
                request a new code
              </button>
              .
            </p>
          ) : null}

          <label className="form-label" htmlFor="otp">
            Verification code
          </label>
          <input
            id="otp"
            className="form-input"
            value={otp}
            onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            required
            autoFocus
          />
          <p className="form-hint">This code expires in {expiresInMinutes} minutes.</p>

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting || otp.length !== 6}>
            {submitting ? 'Verifying…' : 'Verify code'}
          </button>

          <div className="auth-footer">
            Didn't get a code?{' '}
            <button
              type="button"
              className="link-button"
              onClick={handleResendOtp}
              disabled={submitting || resendCountdown > 0}
            >
              {resendCountdown > 0 ? `Resend code (${resendCountdown}s)` : 'Resend code'}
            </button>
          </div>
          <div className="auth-footer">
            <button type="button" className="link-button" onClick={resetFlow}>
              <Icon name="arrowLeft" size={14} /> Use a different email
            </button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  if (step === 'reset') {
    return (
      <AuthLayout title="Set a new password" subtitle="Choose a new password for your account.">
        <form onSubmit={handleResetSubmit} noValidate>
          <ErrorBanner error={error} />

          <label className="form-label" htmlFor="new-password">
            New password
          </label>
          <input
            id="new-password"
            type="password"
            className="form-input"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            required
            autoFocus
          />
          <FieldError message={tooShort ? 'New password must be at least 8 characters.' : null} />

          <label className="form-label" htmlFor="confirm-new-password">
            Confirm new password
          </label>
          <input
            id="confirm-new-password"
            type="password"
            className="form-input"
            value={confirmNewPassword}
            onChange={(event) => setConfirmNewPassword(event.target.value)}
            autoComplete="new-password"
            required
          />
          <FieldError message={mismatch ? 'New password and confirmation do not match.' : null} />

          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={submitting || mismatch || tooShort || !newPassword}
          >
            {submitting ? 'Resetting…' : 'Reset password'}
          </button>

          {resetTokenLikelyInvalid ? (
            <div className="auth-footer">
              <button type="button" className="link-button" onClick={resetFlow}>
                <Icon name="arrowLeft" size={14} /> Request a new code
              </button>
            </div>
          ) : null}
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Forgot your password?" subtitle="Enter your email and we'll send you a verification code.">
      <form onSubmit={handleRequestSubmit} noValidate>
        <ErrorBanner error={error} />

        <label className="form-label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          className="form-input"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="username"
          autoFocus
        />

        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send verification code'}
        </button>

        <div className="auth-footer">
          <Link to="/login">
            <Icon name="arrowLeft" size={14} /> Back to sign in
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}
