import { useEffect, useState } from 'react';

import { createUser, fetchStaffAndInstructors } from '../api/users.js';
import { Badge } from '../components/Badge.jsx';
import { Icon } from '../components/Icon.jsx';
import { Modal } from '../components/Modal.jsx';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';

const ROLE_TONE = { staff: 'tone-blue', instructor: 'tone-green' };
const ROLE_LABEL = { staff: 'Staff', instructor: 'Instructor' };

function TeamMemberForm({ onCancel, onSaved }) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('instructor');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await createUser({ fullName, email, role, password });
      onSaved(result.user);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <ErrorBanner error={error} />

      <label className="form-label" htmlFor="team-name">
        Full name
      </label>
      <input
        id="team-name"
        className="form-input"
        value={fullName}
        onChange={(event) => setFullName(event.target.value)}
        required
        autoFocus
      />

      <label className="form-label" htmlFor="team-email">
        Email
      </label>
      <input
        id="team-email"
        type="email"
        className="form-input"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />

      <label className="form-label" htmlFor="team-role">
        Role
      </label>
      <select
        id="team-role"
        className="form-input"
        value={role}
        onChange={(event) => setRole(event.target.value)}
      >
        <option value="instructor">Instructor</option>
        <option value="staff">Staff</option>
      </select>

      <label className="form-label" htmlFor="team-password">
        Temporary password
      </label>
      <input
        id="team-password"
        type="text"
        className="form-input"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
        minLength={8}
        autoComplete="off"
      />
      <p className="form-hint">
        Share this with them directly — they can change it from their own Profile page after
        logging in.
      </p>

      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Adding…' : 'Add team member'}
        </button>
      </div>
    </form>
  );
}

export function TeamPage() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    fetchStaffAndInstructors()
      .then((data) => setUsers(data.users))
      .catch(setError)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function handleSaved() {
    setModalOpen(false);
    load();
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Team</h1>
          <p className="page-subtitle">Staff and instructor accounts for this studio.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setModalOpen(true)}>
          <Icon name="plus" size={16} />
          Add team member
        </button>
      </div>

      {loading ? <LoadingState label="Loading team…" /> : null}
      {error ? <ErrorBanner error={error} onRetry={load} /> : null}
      {!loading && !error && users?.length === 0 ? (
        <EmptyState
          icon="shield"
          label="No staff or instructor accounts yet."
          action={{ label: 'Add your first team member', onClick: () => setModalOpen(true) }}
        />
      ) : null}

      {!loading && !error && users?.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((teamMember) => (
                <tr key={teamMember.id}>
                  <td>{teamMember.fullName}</td>
                  <td>{teamMember.email}</td>
                  <td>
                    <Badge tone={ROLE_TONE[teamMember.role] ?? 'tone-gray'}>
                      {ROLE_LABEL[teamMember.role] ?? teamMember.role}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {modalOpen ? (
        <Modal
          title="Add team member"
          subtitle="Create a new staff or instructor account."
          onClose={() => setModalOpen(false)}
        >
          <TeamMemberForm onCancel={() => setModalOpen(false)} onSaved={handleSaved} />
        </Modal>
      ) : null}
    </div>
  );
}
