import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { cancelBooking, createBooking, settleBooking } from '../api/bookings.js';
import { fetchMembers } from '../api/members.js';
import { fetchRooms } from '../api/rooms.js';
import {
  addCoInstructor,
  downloadAttendanceCsv,
  fetchCoInstructors,
  fetchSession,
  fetchSessionBookings,
  removeCoInstructor,
} from '../api/sessions.js';
import { fetchInstructors } from '../api/users.js';
import { Avatar } from '../components/Avatar.jsx';
import { StatusBadge } from '../components/Badge.jsx';
import { Icon } from '../components/Icon.jsx';
import { ConfirmDialog } from '../components/Modal.jsx';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';
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
  const [rooms, setRooms] = useState([]);
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
      // `GET /api/rooms` is available to any authenticated role, so it's
      // fetched unconditionally — an instructor should see the room name
      // too, not just staff.
      const [sessionData, bookingsData, coInstructorsData, roomsData] = await Promise.all([
        fetchSession(id),
        fetchSessionBookings(id),
        fetchCoInstructors(id),
        fetchRooms(),
      ]);
      setSession(sessionData.session);
      setBookings(bookingsData.bookings);
      setCoInstructors(coInstructorsData.coInstructors);
      setRooms(roomsData.rooms);
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

  const roomName = rooms.find((r) => String(r.id) === String(session.roomId))?.name;
  const instructorById = Object.fromEntries(instructors.map((i) => [String(i.id), i.fullName]));
  // Resolved from the staff-only instructor list when available; otherwise
  // the viewer's own name when they *are* the primary instructor. Never
  // guessed or left showing a raw id — omitted entirely rather than shown
  // wrong for the one case neither source covers (an instructor viewing a
  // session whose primary is someone else, seen only as a co-instructor).
  const primaryInstructorName =
    instructorById[String(session.primaryInstructorId)] ??
    (String(session.primaryInstructorId) === String(user.id) ? user.fullName : null);

  const now = new Date();
  const startsAt = new Date(session.startsAt);
  const endsAt = new Date(session.endsAt);
  const sessionStatus = now < startsAt ? 'Upcoming' : now < endsAt ? 'In progress' : 'Completed';
  const bookedCount = bookings.filter((b) => ['booked', 'attended', 'no_show'].includes(b.status)).length;
  const waitlistedCount = bookings.filter((b) => b.status === 'waitlisted').length;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Session #{session.id}</h1>
          <p className="page-subtitle">
            {startsAt.toLocaleString(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </p>
        </div>
        <div className="button-row">
          <span
            className={`badge ${sessionStatus === 'Completed' ? 'tone-gray' : sessionStatus === 'In progress' ? 'tone-green' : 'tone-blue'}`}
          >
            {sessionStatus}
          </span>
          <Link to="/sessions" className="btn btn-secondary">
            Back to sessions
          </Link>
        </div>
      </div>

      <section className="card">
        <div className="session-summary-grid">
          <div className="session-summary-item">
            <span className="session-summary-icon">
              <Icon name="clock" size={16} />
            </span>
            <div>
              <div className="session-summary-label">Duration</div>
              <div className="session-summary-value">{session.durationMinutes} minutes</div>
            </div>
          </div>
          {roomName ? (
            <div className="session-summary-item">
              <span className="session-summary-icon">
                <Icon name="sessions" size={16} />
              </span>
              <div>
                <div className="session-summary-label">Room</div>
                <div className="session-summary-value">{roomName}</div>
              </div>
            </div>
          ) : null}
          {primaryInstructorName ? (
            <div className="session-summary-item">
              <span className="session-summary-icon">
                <Icon name="users" size={16} />
              </span>
              <div>
                <div className="session-summary-label">Primary instructor</div>
                <div className="session-summary-value">{primaryInstructorName}</div>
              </div>
            </div>
          ) : null}
          <div className="session-summary-item">
            <span className="session-summary-icon">
              <Icon name="calendar" size={16} />
            </span>
            <div>
              <div className="session-summary-label">Capacity</div>
              <div className="session-summary-value">
                {bookedCount} / {session.capacity} booked
                {waitlistedCount > 0 ? ` · ${waitlistedCount} waitlisted` : ''}
              </div>
            </div>
          </div>
        </div>
        {canActOnSession ? (
          <button type="button" className="btn btn-secondary session-csv-btn" onClick={handleDownloadCsv}>
            <Icon name="download" size={15} />
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
                <span className="person-chip">
                  <Avatar fullName={c.fullName} size={26} />
                  {c.fullName}
                </span>
                {isStaff ? (
                  <button
                    type="button"
                    className="btn btn-ghost-danger btn-small"
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
          <EmptyState icon="bookings" label="No bookings yet." />
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
                      <div className="cell-identity">
                        <span className="cell-identity-primary">
                          <Link to={`/bookings/${booking.id}`}>{booking.member.fullName}</Link>
                        </span>
                        <span className="cell-identity-secondary">{booking.member.email}</span>
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={booking.status} />
                    </td>
                    <td className="col-actions">
                    <div className="table-actions">
                      {canCancel ? (
                        <button
                          type="button"
                          className="btn btn-ghost-danger btn-small"
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
