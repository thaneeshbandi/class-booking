import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { cancelBooking, createBooking, fetchBookings } from '../api/bookings.js';
import { fetchClasses } from '../api/classes.js';
import { fetchMembers } from '../api/members.js';
import { fetchSessions } from '../api/sessions.js';
import { STATUS_LABEL, StatusBadge } from '../components/Badge.jsx';
import { Icon } from '../components/Icon.jsx';
import { ConfirmDialog, Modal } from '../components/Modal.jsx';
import { Pagination } from '../components/Pagination.jsx';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const STATUSES = ['booked', 'waitlisted', 'cancelled', 'attended', 'no_show'];
const SORT_OPTIONS = [
  { value: 'bookedAt', label: 'Booked at' },
  { value: 'status', label: 'Status' },
  { value: 'session', label: 'Session' },
];
const CANCELLABLE = new Set(['booked', 'waitlisted']);

function CreateBookingForm({ members, sessions, onCancel, onCreated }) {
  const [memberId, setMemberId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await createBooking(sessionId, memberId);
      onCreated(result.booking);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <ErrorBanner error={error} />

      <label className="form-label" htmlFor="booking-member">
        Member
      </label>
      <select
        id="booking-member"
        className="form-input"
        value={memberId}
        onChange={(event) => setMemberId(event.target.value)}
        required
      >
        <option value="">Select a member…</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.fullName} ({m.email})
          </option>
        ))}
      </select>

      <label className="form-label" htmlFor="booking-session">
        Session
      </label>
      <select
        id="booking-session"
        className="form-input"
        value={sessionId}
        onChange={(event) => setSessionId(event.target.value)}
        required
      >
        <option value="">Select a session…</option>
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            #{s.id} — {new Date(s.startsAt).toLocaleString()}
          </option>
        ))}
      </select>

      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Booking…' : 'Create booking'}
        </button>
      </div>
    </form>
  );
}

export function BookingsPage() {
  const { isStaff } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const classId = searchParams.get('classId') ?? '';
  const status = searchParams.get('status') ?? '';
  const sort = searchParams.get('sort') ?? 'bookedAt';
  const direction = searchParams.get('direction') ?? 'desc';
  const page = Number(searchParams.get('page') ?? '1');

  const [data, setData] = useState(null);
  const [classes, setClasses] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [members, setMembers] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [actionError, setActionError] = useState(null);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchBookings({ q, classId, status, sort, direction, page, pageSize: 20 }),
      fetchClasses(),
    ])
      .then(([bookingsData, classesData]) => {
        setData(bookingsData);
        setClasses(classesData.classes);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }

  useEffect(load, [q, classId, status, sort, direction, page]);

  function updateParam(key, value) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    // A filter/sort change restarts pagination — but this function is also
    // how Pagination's own onPageChange navigates *to* a page, so it must
    // not strip the very key it was just asked to set.
    if (key !== 'page') next.delete('page');
    setSearchParams(next);
  }

  function openCreateForm() {
    setActionError(null);
    Promise.all([fetchMembers(), fetchSessions()])
      .then(([membersData, sessionsData]) => {
        setMembers(membersData.members);
        setSessions(sessionsData.sessions);
        setShowCreate(true);
      })
      .catch(setActionError);
  }

  function handleCreated() {
    setShowCreate(false);
    load();
  }

  async function handleCancel() {
    setActionError(null);
    try {
      await cancelBooking(cancelTarget.id);
      setCancelTarget(null);
      load();
    } catch (err) {
      setActionError(err);
      setCancelTarget(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Bookings</h1>
          <p className="page-subtitle">Search, filter, and manage bookings across every session.</p>
        </div>
        {isStaff ? (
          <button type="button" className="btn btn-primary" onClick={openCreateForm}>
            <Icon name="plus" size={16} />
            Create booking
          </button>
        ) : null}
      </div>

      {/* The four <select> elements below keep their original DOM order
       * (class, status, sort, direction) even though this is now visually
       * grouped — existing Playwright coverage addresses them by that fixed
       * order, since none of them has an individually associated <label>. */}
      <div className="filter-bar">
        <div className="search-field">
          <Icon name="search" size={15} className="search-field-icon" />
          <input
            className="form-input"
            placeholder="Search member name or email…"
            defaultValue={q}
            onKeyDown={(event) => {
              if (event.key === 'Enter') updateParam('q', event.target.value);
            }}
            onBlur={(event) => updateParam('q', event.target.value)}
          />
        </div>
        <select className="form-input" value={classId} onChange={(event) => updateParam('classId', event.target.value)}>
          <option value="">All classes</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <select className="form-input" value={status} onChange={(event) => updateParam('status', event.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select className="form-input" value={sort} onChange={(event) => updateParam('sort', event.target.value)}>
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              Sort: {option.label}
            </option>
          ))}
        </select>
        <select
          className="form-input"
          value={direction}
          onChange={(event) => updateParam('direction', event.target.value)}
        >
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>
        {q || classId || status ? (
          <button type="button" className="btn btn-secondary" onClick={() => setSearchParams({})}>
            <Icon name="close" size={14} />
            Clear filters
          </button>
        ) : null}
      </div>

      {loading ? <LoadingState label="Loading bookings…" /> : null}
      {error ? <ErrorBanner error={error} onRetry={load} /> : null}
      {actionError ? <ErrorBanner error={actionError} /> : null}
      {!loading && !error && data?.bookings.length === 0 ? (
        <EmptyState icon="search" label="No bookings match these filters." />
      ) : null}

      {!loading && !error && data?.bookings.length > 0 ? (
        <>
          <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Class</th>
                <th>Session</th>
                <th>Status</th>
                <th>Booked at</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.bookings.map((booking) => {
                const canCancel = isStaff && CANCELLABLE.has(booking.status);
                return (
                  <tr key={booking.id}>
                    <td>
                      <div className="cell-identity">
                        <span className="cell-identity-primary">
                          <Link to={`/bookings/${booking.id}`}>{booking.member.fullName}</Link>
                        </span>
                        <span className="cell-identity-secondary">{booking.class.title}</span>
                      </div>
                    </td>
                    <td>
                      <Link to={`/sessions/${booking.session.id}`} className="metadata-chip">
                        <Icon name="calendar" size={13} />
                        {new Date(booking.session.startsAt).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={booking.status} />
                    </td>
                    <td>
                      <span className="cell-identity-secondary">
                        {new Date(booking.bookedAt).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    </td>
                    <td className="col-actions">
                      <div className="table-actions">
                        {canCancel ? (
                          <button
                            type="button"
                            className="btn btn-ghost-danger btn-small"
                            onClick={() => setCancelTarget(booking)}
                          >
                            Cancel
                          </button>
                        ) : (
                          <span className="table-actions-placeholder" aria-hidden="true">
                            —
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <Pagination
            page={data.pagination.page}
            totalPages={data.pagination.totalPages}
            total={data.pagination.total}
            onPageChange={(next) => updateParam('page', String(next))}
          />
        </>
      ) : null}

      {showCreate ? (
        <Modal title="Create booking" onClose={() => setShowCreate(false)}>
          <CreateBookingForm
            members={members}
            sessions={sessions}
            onCancel={() => setShowCreate(false)}
            onCreated={handleCreated}
          />
        </Modal>
      ) : null}

      {cancelTarget ? (
        <ConfirmDialog
          title="Cancel booking"
          message={`Cancel ${cancelTarget.member.fullName}'s booking? This may promote the next waitlisted member.`}
          confirmLabel="Cancel booking"
          danger
          onConfirm={handleCancel}
          onClose={() => setCancelTarget(null)}
        />
      ) : null}
    </div>
  );
}
