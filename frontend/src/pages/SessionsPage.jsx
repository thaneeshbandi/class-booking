import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { fetchClasses } from '../api/classes.js';
import { fetchRooms } from '../api/rooms.js';
import { createSession, deleteSession, fetchSessions, updateSession } from '../api/sessions.js';
import { fetchInstructors } from '../api/users.js';
import { ConfirmDialog, Modal } from '../components/Modal.jsx';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';

function toDatetimeLocal(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function ConflictList({ conflicts }) {
  if (!conflicts?.length) return null;
  return (
    <div className="conflict-list">
      <strong>Conflicts:</strong>
      <ul>
        {conflicts.map((c, i) => (
          <li key={i}>
            {c.type === 'room' ? 'Room' : `Instructor #${c.instructorId}`} conflicts with session #
            {c.sessionId} ({new Date(c.startsAt).toLocaleString()} – {new Date(c.endsAt).toLocaleString()})
          </li>
        ))}
      </ul>
    </div>
  );
}

function SessionForm({ initial, classes, rooms, instructors, onCancel, onSaved }) {
  const isEdit = Boolean(initial);
  const [classId, setClassId] = useState(initial?.classId ?? classes[0]?.id ?? '');
  const [primaryInstructorId, setPrimaryInstructorId] = useState(
    initial?.primaryInstructorId ?? instructors[0]?.id ?? '',
  );
  const [roomId, setRoomId] = useState(initial?.roomId ?? rooms[0]?.id ?? '');
  const [startsAt, setStartsAt] = useState(toDatetimeLocal(initial?.startsAt));
  const [durationMinutes, setDurationMinutes] = useState(initial?.durationMinutes ?? '');
  const [capacity, setCapacity] = useState(initial?.capacity ?? '');
  const [error, setError] = useState(null);
  const [conflicts, setConflicts] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setConflicts(null);
    setSubmitting(true);
    try {
      // `PATCH /api/sessions/:id` has no `classId` field at all — a session's
      // class cannot be changed after creation — so it is only ever sent on
      // create. Sending it on an edit would do nothing (the backend's update
      // schema silently strips unknown keys), so the field is disabled below
      // during edit rather than left looking editable with no effect.
      const body = {
        ...(isEdit ? {} : { classId: Number(classId) }),
        primaryInstructorId: Number(primaryInstructorId),
        roomId: Number(roomId),
        startsAt: new Date(startsAt).toISOString(),
        ...(durationMinutes ? { durationMinutes: Number(durationMinutes) } : {}),
        ...(capacity ? { capacity: Number(capacity) } : {}),
      };
      const result = isEdit ? await updateSession(initial.id, body) : await createSession(body);
      onSaved(result);
    } catch (err) {
      if (err.body?.conflicts) setConflicts(err.body.conflicts);
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <ErrorBanner error={error} />
      <ConflictList conflicts={conflicts} />

      <label className="form-label" htmlFor="session-class">
        Class{isEdit ? ' (cannot be changed after creation)' : ''}
      </label>
      <select
        id="session-class"
        className="form-input"
        value={classId}
        onChange={(event) => setClassId(event.target.value)}
        required
        disabled={isEdit}
      >
        {classes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>

      <div className="form-row">
        <div>
          <label className="form-label" htmlFor="session-instructor">
            Primary instructor
          </label>
          <select
            id="session-instructor"
            className="form-input"
            value={primaryInstructorId}
            onChange={(event) => setPrimaryInstructorId(event.target.value)}
            required
          >
            {instructors.map((i) => (
              <option key={i.id} value={i.id}>
                {i.fullName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="form-label" htmlFor="session-room">
            Room
          </label>
          <select
            id="session-room"
            className="form-input"
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            required
          >
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <label className="form-label" htmlFor="session-starts-at">
        Starts at (your local time)
      </label>
      <input
        id="session-starts-at"
        type="datetime-local"
        className="form-input"
        value={startsAt}
        onChange={(event) => setStartsAt(event.target.value)}
        required
      />

      <div className="form-row">
        <div>
          <label className="form-label" htmlFor="session-duration">
            Duration (minutes, optional — defaults from class)
          </label>
          <input
            id="session-duration"
            type="number"
            min="1"
            className="form-input"
            value={durationMinutes}
            onChange={(event) => setDurationMinutes(event.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="session-capacity">
            Capacity (optional — defaults from class)
          </label>
          <input
            id="session-capacity"
            type="number"
            min="1"
            className="form-input"
            value={capacity}
            onChange={(event) => setCapacity(event.target.value)}
          />
        </div>
      </div>

      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create session'}
        </button>
      </div>
    </form>
  );
}

export function SessionsPage() {
  const { isStaff } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const classIdFilter = searchParams.get('classId') ?? '';

  const [sessions, setSessions] = useState(null);
  const [classes, setClasses] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [instructors, setInstructors] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchSessions(classIdFilter || undefined),
      fetchClasses(),
      fetchRooms(),
      isStaff ? fetchInstructors() : Promise.resolve({ users: [] }),
    ])
      .then(([sessionsData, classesData, roomsData, instructorsData]) => {
        setSessions(sessionsData.sessions);
        setClasses(classesData.classes);
        setRooms(roomsData.rooms);
        setInstructors(instructorsData.users);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }

  useEffect(load, [classIdFilter, isStaff]);

  const classById = Object.fromEntries(classes.map((c) => [c.id, c]));
  const roomById = Object.fromEntries(rooms.map((r) => [r.id, r]));
  const instructorById = Object.fromEntries(instructors.map((i) => [i.id, i]));

  function handleSaved(result) {
    setModal(null);
    setNotice(
      result.promoted?.length
        ? `Saved. ${result.promoted.length} waitlisted booking(s) were promoted.`
        : null,
    );
    load();
  }

  async function handleDelete() {
    setActionError(null);
    try {
      await deleteSession(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      setActionError(err);
      setDeleteTarget(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{isStaff ? 'Sessions' : 'My Sessions'}</h1>
        {isStaff ? (
          <div className="button-row">
            <Link to="/sessions/recurring" className="btn btn-secondary">
              Generate recurring
            </Link>
            <button type="button" className="btn btn-primary" onClick={() => setModal('create')}>
              Create session
            </button>
          </div>
        ) : null}
      </div>

      <label className="form-label" htmlFor="class-filter">
        Filter by class
      </label>
      <select
        id="class-filter"
        className="form-input form-input-inline"
        value={classIdFilter}
        onChange={(event) => setSearchParams(event.target.value ? { classId: event.target.value } : {})}
      >
        <option value="">All classes</option>
        {classes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>

      {notice ? <div className="state-block state-success">{notice}</div> : null}
      {loading ? <LoadingState label="Loading sessions…" /> : null}
      {error ? <ErrorBanner error={error} onRetry={load} /> : null}
      {actionError ? <ErrorBanner error={actionError} /> : null}
      {!loading && !error && sessions?.length === 0 ? (
        <EmptyState label="No sessions to show." />
      ) : null}

      {!loading && !error && sessions?.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Class</th>
              <th>Starts</th>
              <th>Room</th>
              <th>Instructor</th>
              <th className="numeric">Capacity</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id}>
                <td>{classById[session.classId]?.title ?? `#${session.classId}`}</td>
                <td>{new Date(session.startsAt).toLocaleString()}</td>
                <td>{roomById[session.roomId]?.name ?? `#${session.roomId}`}</td>
                <td>{instructorById[session.primaryInstructorId]?.fullName ?? `#${session.primaryInstructorId}`}</td>
                <td className="numeric">{session.capacity}</td>
                <td className="table-actions">
                  <Link className="btn btn-secondary btn-small" to={`/sessions/${session.id}`}>
                    View
                  </Link>
                  {isStaff ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => setModal(session)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-small"
                        onClick={() => setDeleteTarget(session)}
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {modal ? (
        <Modal title={modal === 'create' ? 'Create session' : 'Edit session'} onClose={() => setModal(null)}>
          <SessionForm
            initial={modal === 'create' ? null : modal}
            classes={classes}
            rooms={rooms}
            instructors={instructors}
            onCancel={() => setModal(null)}
            onSaved={handleSaved}
          />
        </Modal>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="Delete session"
          message="Delete this session? This only works if it has no bookings."
          confirmLabel="Delete"
          danger
          onConfirm={handleDelete}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </div>
  );
}
