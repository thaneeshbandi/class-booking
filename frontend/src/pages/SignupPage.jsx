import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import { ErrorBanner } from '../components/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD_LENGTH = 8;

/**
 * Public self-service signup. There is deliberately no role selector
 * anywhere on this page, and nothing here sends a `role` field to the API —
 * every account created through this form is the unprivileged `member` role,
 * decided entirely server-side (see `docs/decisions.md`). This form only
 * ever collects what a non-privileged signup needs.
 */
export function SignupPage() {
  const { user, signup } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) {
    const from = location.state?.from?.pathname || '/';
    return <Navigate to={from} replace />;
  }

  function validate() {
    const errors = {};
    if (!fullName.trim()) errors.fullName = 'Full name is required.';
    if (!email.trim()) errors.email = 'Email is required.';
    else if (!EMAIL_PATTERN.test(email.trim())) errors.email = 'Enter a valid email address.';
    if (!password) errors.password = 'Password is required.';
    else if (password.length < MIN_PASSWORD_LENGTH) {
      errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (confirmPassword !== password) errors.confirmPassword = 'Passwords do not match.';
    return errors;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      await signup(fullName.trim(), email.trim(), password);
      const from = location.state?.from?.pathname || '/';
      navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={handleSubmit} noValidate>
        <div className="auth-brand">
          <span className="auth-brand-mark" aria-hidden="true" />
          <h1>Class Booking</h1>
        </div>
        <p className="auth-subtitle">Create your account.</p>

        <ErrorBanner error={error} />

        <label className="form-label" htmlFor="signup-name">
          Full name
        </label>
        <input
          id="signup-name"
          className={`form-input${fieldErrors.fullName ? ' has-error' : ''}`}
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          autoComplete="name"
          autoFocus
        />
        {fieldErrors.fullName ? <p className="field-error">{fieldErrors.fullName}</p> : null}

        <label className="form-label" htmlFor="signup-email">
          Email
        </label>
        <input
          id="signup-email"
          type="email"
          className={`form-input${fieldErrors.email ? ' has-error' : ''}`}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="username"
        />
        {fieldErrors.email ? <p className="field-error">{fieldErrors.email}</p> : null}

        <label className="form-label" htmlFor="signup-password">
          Password
        </label>
        <input
          id="signup-password"
          type="password"
          className={`form-input${fieldErrors.password ? ' has-error' : ''}`}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
        />
        {fieldErrors.password ? (
          <p className="field-error">{fieldErrors.password}</p>
        ) : (
          <p className="form-help">At least {MIN_PASSWORD_LENGTH} characters.</p>
        )}

        <label className="form-label" htmlFor="signup-confirm-password">
          Confirm password
        </label>
        <input
          id="signup-confirm-password"
          type="password"
          className={`form-input${fieldErrors.confirmPassword ? ' has-error' : ''}`}
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          autoComplete="new-password"
        />
        {fieldErrors.confirmPassword ? <p className="field-error">{fieldErrors.confirmPassword}</p> : null}

        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Sign up'}
        </button>

        <div className="auth-footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
      </form>
    </div>
  );
}
