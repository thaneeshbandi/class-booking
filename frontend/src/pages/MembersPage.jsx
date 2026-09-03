import { useEffect, useState } from 'react';

import { createMember, fetchMembers, updateMember } from '../api/members.js';
import { Badge } from '../components/Badge.jsx';
import { Icon } from '../components/Icon.jsx';
import { Modal } from '../components/Modal.jsx';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A purely cosmetic mirror of the 7-day alert window the backend applies
 * (see `domain/membership.js#isWithinAlertWindow`) — display-only, so a
 * staff member scanning this table can already see roughly what the Alerts
 * page will show, without this page making any authorization or business
 * decision of its own. The Alerts page's own server-computed values remain
 * the authoritative source for anything that actually acts on this.
 */
function membershipStatus(expiresOn) {
  const diffDays = Math.round((new Date(`${expiresOn}T00:00:00`) - new Date(`${todayIsoDate()}T00:00:00`)) / 86_400_000);
  if (diffDays < 0) return { label: 'Expired', tone: 'tone-red' };
  if (diffDays <= 7) return { label: 'Expiring soon', tone: 'tone-amber' };
  return { label: 'Active', tone: 'tone-green' };
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
          <Icon name="plus" size={16} />
          Add member
        </button>
      </div>

      {loading ? <LoadingState label="Loading members…" /> : null}
      {error ? <ErrorBanner error={error} onRetry={load} /> : null}
      {!loading && !error && members?.length === 0 ? (
        <EmptyState
          icon="members"
          label="No members yet."
          action={{ label: 'Add your first member', onClick: () => setModal('create') }}
        />
      ) : null}

      {!loading && !error && members?.length > 0 ? (
        <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Membership</th>
              <th className="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const status = membershipStatus(member.membershipExpiresOn);
              return (
                <tr key={member.id}>
                  <td>
                    <div className="cell-identity">
                      <span className="cell-identity-primary">{member.fullName}</span>
                      <span className="cell-identity-secondary">{member.email}</span>
                    </div>
                  </td>
                  <td>
                    <div className="membership-cell">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <span className="metadata-chip">
                        <Icon name="calendar" size={13} />
                        {member.membershipExpiresOn}
                      </span>
                    </div>
                  </td>
                  <td className="col-actions">
                  <div className="table-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={() => setModal(member)}
                    >
                      <Icon name="edit" size={13} />
                      Edit
                    </button>
                  </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      ) : null}

      {modal ? (
        <Modal
          title={modal === 'create' ? 'Add member' : 'Edit member'}
          subtitle={modal === 'create' ? 'Create a new member record.' : `Editing "${modal.fullName}".`}
          onClose={() => setModal(null)}
        >
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
