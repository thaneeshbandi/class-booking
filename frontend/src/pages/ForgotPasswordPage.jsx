import { useState } from 'react';
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

  async function handleRequestSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(email);
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
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResendOtp() {
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(email);
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

  if (step === 'done') {
    return (
      <AuthLayout title="Password reset" subtitle="You can now sign in with your new password.">
        <div className="state-block state-success" role="status">
          <Icon name="check" size={16} />
          Your password has been reset.
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

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting || otp.length !== 6}>
            {submitting ? 'Verifying…' : 'Verify code'}
          </button>

          <div className="auth-footer">
            Didn't get a code?{' '}
            <button type="button" className="link-button" onClick={handleResendOtp} disabled={submitting}>
              Resend code
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
