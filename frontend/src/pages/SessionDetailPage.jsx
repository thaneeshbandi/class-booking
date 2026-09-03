import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { cancelBooking, createBooking, settleBooking } from '../api/bookings.js';
import { fetchMembers } from '../api/members.js';
import {
  addCoInstructor,
  downloadAttendanceCsv,
  fetchCoInstructors,
  fetchSession,
  fetchSessionBookings,
  removeCoInstructor,
} from '../api/sessions.js';
import { fetchInstructors } from '../api/users.js';
import { StatusBadge } from '../components/Badge.jsx';
import { ConfirmDialog } from '../components/Modal.jsx';
import { ErrorBanner, LoadingState } from '../components/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const CANCELLABLE = new Set(['booked', 'waitlisted']);

export function SessionDetailPage() {
  const { id } = useParams();
  const { user, isStaff } = useAuth();

  const [session, setSession] = useState(null);
  const [bookings, setBookings] = useState(null);
  const [coInstructors, setCoInstructors] = useState(null);
  const [members, setMembers] = useState([]);
  const [instructors, setInstructors] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const [bookingMemberId, setBookingMemberId] = useState('');
  const [newCoInstructorId, setNewCoInstructorId] = useState('');
  const [actionError, setActionError] = useState(null);
  const [busyBookingId, setBusyBookingId] = useState(null);
  const [cancelTarget, setCancelTarget] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [sessionData, bookingsData, coInstructorsData] = await Promise.all([
        fetchSession(id),
        fetchSessionBookings(id),
        fetchCoInstructors(id),
      ]);
      setSession(sessionData.session);
      setBookings(bookingsData.bookings);
      setCoInstructors(coInstructorsData.coInstructors);
      if (isStaff) {
        const [membersData, instructorsData] = await Promise.all([
          fetchMembers(),
          fetchInstructors(),
        ]);
        setMembers(membersData.members);
        setInstructors(instructorsData.users);
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const canActOnSession =
    isStaff ||
    (session && String(session.primaryInstructorId) === String(user.id)) ||
    coInstructors?.some((c) => String(c.id) === String(user.id));

  async function handleCreateBooking(event) {
    event.preventDefault();
    setActionError(null);
    try {
      await createBooking(id, bookingMemberId);
      setBookingMemberId('');
      load();
    } catch (err) {
      setActionError(err);
    }
  }

  async function handleCancel() {
    setActionError(null);
    setBusyBookingId(cancelTarget.id);
    try {
      await cancelBooking(cancelTarget.id);
      setCancelTarget(null);
      load();
    } catch (err) {
      setActionError(err);
      setCancelTarget(null);
    } finally {
      setBusyBookingId(null);
    }
  }

  async function handleSettle(bookingId, status) {
    setActionError(null);
    setBusyBookingId(bookingId);
    try {
      await settleBooking(bookingId, status);
      load();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusyBookingId(null);
    }
  }

  async function handleAddCoInstructor(event) {
    event.preventDefault();
    setActionError(null);
    try {
      await addCoInstructor(id, newCoInstructorId);
      setNewCoInstructorId('');
      load();
    } catch (err) {
      setActionError(err);
    }
  }

  async function handleRemoveCoInstructor(instructorId) {
    setActionError(null);
    try {
      await removeCoInstructor(id, instructorId);
      load();
    } catch (err) {
      setActionError(err);
    }
  }

  async function handleDownloadCsv() {
    setActionError(null);
    try {
      await downloadAttendanceCsv(id);
    } catch (err) {
      setActionError(err);
    }
  }

  if (loading) return <LoadingState label="Loading session…" />;
  if (error) return <ErrorBanner error={error} onRetry={load} />;
  if (!session) return null;

  const availableInstructors = instructors.filter(
    (i) =>
      String(i.id) !== String(session.primaryInstructorId) &&
      !coInstructors.some((c) => String(c.id) === String(i.id)),
  );

  return (
    <div>
      <div className="page-header">
        <h1>Session #{session.id}</h1>
        <Link to="/sessions" className="btn btn-secondary">
          Back to sessions
        </Link>
      </div>

      <section className="card">
        <dl className="detail-list">
          <dt>Starts</dt>
          <dd>{new Date(session.startsAt).toLocaleString()}</dd>
          <dt>Ends</dt>
          <dd>{new Date(session.endsAt).toLocaleString()}</dd>
          <dt>Duration</dt>
          <dd>{session.durationMinutes} minutes</dd>
          <dt>Capacity</dt>
          <dd>{session.capacity}</dd>
        </dl>
        {canActOnSession ? (
          <button type="button" className="btn btn-secondary" onClick={handleDownloadCsv}>
            Download attendance CSV
          </button>
        ) : null}
      </section>

      {actionError ? <ErrorBanner error={actionError} /> : null}

      <section className="card">
        <h2>Co-instructors</h2>
        {coInstructors.length === 0 ? (
          <p className="muted">No co-instructors assigned.</p>
        ) : (
          <ul className="plain-list">
            {coInstructors.map((c) => (
              <li key={c.id}>
                {c.fullName}
                {isStaff ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={() => handleRemoveCoInstructor(c.id)}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {isStaff && availableInstructors.length > 0 ? (
          <form className="inline-form" onSubmit={handleAddCoInstructor}>
            <select
              className="form-input"
              value={newCoInstructorId}
              onChange={(event) => setNewCoInstructorId(event.target.value)}
              required
            >
              <option value="">Add a co-instructor…</option>
              {availableInstructors.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.fullName}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-secondary" disabled={!newCoInstructorId}>
              Add
            </button>
          </form>
        ) : null}
      </section>

      <section className="card">
        <h2>Bookings</h2>
        {isStaff ? (
          <form className="inline-form" onSubmit={handleCreateBooking}>
            <select
              className="form-input"
              value={bookingMemberId}
              onChange={(event) => setBookingMemberId(event.target.value)}
              required
            >
              <option value="">Book a member…</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.fullName} ({m.email})
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-primary" disabled={!bookingMemberId}>
              Book
            </button>
          </form>
        ) : null}

        {bookings.length === 0 ? (
          <p className="muted">No bookings yet.</p>
        ) : (
          <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Status</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((booking) => {
                const canCancel = isStaff && CANCELLABLE.has(booking.status);
                const canSettle = canActOnSession && booking.status === 'booked';
                return (
                  <tr key={booking.id}>
                    <td>
                      <Link to={`/bookings/${booking.id}`}>{booking.member.fullName}</Link>
                      <div className="muted">{booking.member.email}</div>
                    </td>
                    <td>
                      <StatusBadge status={booking.status} />
                    </td>
                    <td className="col-actions">
                    <div className="table-actions">
                      {canCancel ? (
                        <button
                          type="button"
                          className="btn btn-danger btn-small"
                          disabled={busyBookingId === booking.id}
                          onClick={() => setCancelTarget(booking)}
                        >
                          Cancel
                        </button>
                      ) : null}
                      {canSettle ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-secondary btn-small"
                            disabled={busyBookingId === booking.id}
                            onClick={() => handleSettle(booking.id, 'attended')}
                          >
                            Attended
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-small"
                            disabled={busyBookingId === booking.id}
                            onClick={() => handleSettle(booking.id, 'no_show')}
                          >
                            No-show
                          </button>
                        </>
                      ) : null}
                      {!canCancel && !canSettle ? (
                        <span className="table-actions-placeholder" aria-hidden="true">
                          —
                        </span>
                      ) : null}
                    </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </section>

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
