import { useEffect, useState } from 'react';

import { changePassword, fetchProfile, updateProfile } from '../api/profile.js';
import { Avatar } from '../components/Avatar.jsx';
import { Icon } from '../components/Icon.jsx';
import { EmptyState, ErrorBanner, FieldError, LoadingState } from '../components/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const ROLE_LABEL = { staff: 'Staff', instructor: 'Instructor', member: 'Member' };

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function NameForm({ profile, onSaved }) {
  const { updateLocalUser } = useAuth();
  const [fullName, setFullName] = useState(profile.fullName);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const result = await updateProfile(fullName);
      onSaved(result.profile);
      updateLocalUser({ fullName: result.profile.fullName });
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <ErrorBanner error={error} />
      {saved ? (
        <div className="state-block state-success" role="status">
          <Icon name="check" size={16} />
          Your name has been updated.
        </div>
      ) : null}

      <label className="form-label" htmlFor="profile-full-name">
        Full name
      </label>
      <input
        id="profile-full-name"
        className="form-input"
        value={fullName}
        onChange={(event) => {
          setFullName(event.target.value);
          setSaved(false);
        }}
        required
      />

      <label className="form-label" htmlFor="profile-email">
        Email
      </label>
      <input id="profile-email" className="form-input" value={profile.email} disabled readOnly />
      <p className="field-hint">
        Email can't be changed — it's how your account is identified and matched to your membership.
      </p>

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving || !fullName.trim()}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const mismatch = confirmNewPassword.length > 0 && newPassword !== confirmNewPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < 8;

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      await changePassword(currentPassword, newPassword, confirmNewPassword);
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <ErrorBanner error={error} />
      {success ? (
        <div className="state-block state-success" role="status">
          <Icon name="check" size={16} />
          Your password has been changed. You'll stay signed in on this device.
        </div>
      ) : null}

      <label className="form-label" htmlFor="current-password">
        Current password
      </label>
      <input
        id="current-password"
        type="password"
        className="form-input"
        value={currentPassword}
        onChange={(event) => setCurrentPassword(event.target.value)}
        autoComplete="current-password"
        required
      />

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

      <div className="form-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={saving || mismatch || tooShort || !currentPassword || !newPassword}
        >
          {saving ? 'Changing…' : 'Change password'}
        </button>
      </div>
    </form>
  );
}

/**
 * Every authenticated role's profile page — staff, instructor and member
 * alike. Role itself is shown but never editable here (no field for it on
 * any request this page sends); a role change has no exposure through this
 * page at all, by design (see `docs/decisions.md`).
 */
export function ProfilePage() {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    fetchProfile()
      .then((data) => setProfile(data.profile))
      .catch(setError)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  if (loading) return <LoadingState label="Loading your profile…" />;
  if (error) return <ErrorBanner error={error} onRetry={load} />;
  if (!profile) return <EmptyState label="Your profile isn't available right now." />;

  return (
    <div>
      <div className="profile-header card">
        <Avatar fullName={profile.fullName} size={56} />
        <div>
          <h1>{profile.fullName}</h1>
          <span className={`badge ${profile.role === 'staff' ? 'tone-blue' : profile.role === 'instructor' ? 'tone-amber' : 'tone-green'}`}>
            {ROLE_LABEL[profile.role] ?? profile.role}
          </span>
        </div>
      </div>

      <section className="card">
        <h2>Personal information</h2>
        <NameForm profile={profile} onSaved={setProfile} />
      </section>

      <section className="card">
        <h2>
          <Icon name="lock" size={16} /> Security
        </h2>
        <PasswordForm />
      </section>

      <section className="card">
        <h2>Account</h2>
        <dl className="profile-account-details">
          <dt>Role</dt>
          <dd>{ROLE_LABEL[profile.role] ?? profile.role}</dd>
          <dt>Member since</dt>
          <dd>{formatDate(profile.createdAt)}</dd>
        </dl>
      </section>
    </div>
  );
}
