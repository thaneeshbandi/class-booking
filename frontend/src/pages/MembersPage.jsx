import { useEffect, useState } from 'react';

import { createMember, fetchMembers, updateMember } from '../api/members.js';
import { Modal } from '../components/Modal.jsx';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function MemberForm({ initial, onCancel, onSaved }) {
  const isEdit = Boolean(initial);
  const [fullName, setFullName] = useState(initial?.fullName ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [membershipExpiresOn, setMembershipExpiresOn] = useState(
    initial?.membershipExpiresOn ?? todayIsoDate(),
  );
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body = { fullName, email, membershipExpiresOn };
      const result = isEdit ? await updateMember(initial.id, body) : await createMember(body);
      onSaved(result.member);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <ErrorBanner error={error} />

      <label className="form-label" htmlFor="member-name">
        Full name
      </label>
      <input
        id="member-name"
        className="form-input"
        value={fullName}
        onChange={(event) => setFullName(event.target.value)}
        required
        autoFocus
      />

      <label className="form-label" htmlFor="member-email">
        Email
      </label>
      <input
        id="member-email"
        type="email"
        className="form-input"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />

      <label className="form-label" htmlFor="member-expiry">
        Membership expires on
      </label>
      <input
        id="member-expiry"
        type="date"
        className="form-input"
        value={membershipExpiresOn}
        onChange={(event) => setMembershipExpiresOn(event.target.value)}
        required
      />

      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Add member'}
        </button>
      </div>
    </form>
  );
}

export function MembersPage() {
  const [members, setMembers] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | 'create' | member object being edited

  function load() {
    setLoading(true);
    setError(null);
    fetchMembers()
      .then((data) => setMembers(data.members))
      .catch(setError)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function handleSaved() {
    setModal(null);
    load();
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Members</h1>
          <p className="page-subtitle">Add members and keep their membership expiry up to date.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setModal('create')}>
          Add member
        </button>
      </div>

      {loading ? <LoadingState label="Loading members…" /> : null}
      {error ? <ErrorBanner error={error} onRetry={load} /> : null}
      {!loading && !error && members?.length === 0 ? <EmptyState label="No members yet." /> : null}

      {!loading && !error && members?.length > 0 ? (
        <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Membership expires</th>
              <th className="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.id}>
                <td>{member.fullName}</td>
                <td>{member.email}</td>
                <td>{member.membershipExpiresOn}</td>
                <td className="col-actions">
                <div className="table-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={() => setModal(member)}
                  >
                    Edit
                  </button>
                </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : null}

      {modal ? (
        <Modal title={modal === 'create' ? 'Add member' : 'Edit member'} onClose={() => setModal(null)}>
          <MemberForm
            initial={modal === 'create' ? null : modal}
            onCancel={() => setModal(null)}
            onSaved={handleSaved}
          />
        </Modal>
      ) : null}
    </div>
  );
}
