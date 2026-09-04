import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { fetchClasses } from '../api/classes.js';
import { fetchRooms } from '../api/rooms.js';
import { createSession, deleteSession, fetchSessions, updateSession } from '../api/sessions.js';
import { fetchInstructors } from '../api/users.js';
import { Icon } from '../components/Icon.jsx';
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

      <div className="form-section">
        <h3 className="form-section-title">Class &amp; instructor</h3>
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
      </div>

      <div className="form-section">
        <h3 className="form-section-title">Date &amp; time</h3>
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
      </div>

      <div className="form-section form-section-last">
        <h3 className="form-section-title">Duration &amp; capacity</h3>
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

const ROLE_FILTER_OPTIONS = [
  { value: '', label: 'All my sessions' },
  { value: 'primary', label: 'Primary instructor' },
  { value: 'co', label: 'Co-instructor' },
];

export function SessionsPage() {
  const { isStaff, isInstructor } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const classIdFilter = searchParams.get('classId') ?? '';
  const dateFrom = searchParams.get('dateFrom') ?? '';
  const dateTo = searchParams.get('dateTo') ?? '';
  // Meaningful only for an instructor — the backend already ignores it for
  // a staff caller (they see every session unscoped regardless), and the
  // control itself is only rendered below for `isInstructor`.
  const roleFilter = searchParams.get('role') ?? '';

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
      fetchSessions({ classId: classIdFilter, dateFrom, dateTo, role: roleFilter }),
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

  useEffect(load, [classIdFilter, dateFrom, dateTo, roleFilter, isStaff]);

  function updateFilter(key, value) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  }

  const hasFilters = Boolean(classIdFilter || dateFrom || dateTo || roleFilter);

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
        <div className="page-header-text">
          <h1>{isStaff ? 'Sessions' : isInstructor ? 'My Sessions' : 'Sessions'}</h1>
          <p className="page-subtitle">
            {isStaff
              ? 'Every scheduled session across all classes, rooms, and instructors.'
              : isInstructor
                ? 'Sessions where you are the primary or a co-instructor.'
                : 'Sessions you have a relationship to.'}
          </p>
        </div>
        {isStaff ? (
          <div className="button-row">
            <Link to="/sessions/recurring" className="btn btn-secondary">
              <Icon name="calendar" size={15} />
              Generate recurring
            </Link>
            <button type="button" className="btn btn-primary" onClick={() => setModal('create')}>
              <Icon name="plus" size={16} />
              Create session
            </button>
          </div>
        ) : null}
      </div>

      <div className="filter-bar">
        <div className="filter-field">
          <label className="form-label" htmlFor="class-filter">
            Class
          </label>
          <select
            id="class-filter"
            className="form-input"
            value={classIdFilter}
            onChange={(event) => updateFilter('classId', event.target.value)}
          >
            <option value="">All classes</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label className="form-label" htmlFor="session-date-from">
            From
          </label>
          <input
            id="session-date-from"
            type="date"
            className="form-input"
            value={dateFrom}
            onChange={(event) => updateFilter('dateFrom', event.target.value)}
          />
        </div>
        <div className="filter-field">
          <label className="form-label" htmlFor="session-date-to">
            To
          </label>
          <input
            id="session-date-to"
            type="date"
            className="form-input"
            value={dateTo}
            onChange={(event) => updateFilter('dateTo', event.target.value)}
          />
        </div>
        {isInstructor ? (
          <div className="filter-field">
            <label className="form-label" htmlFor="session-role-filter">
              Role
            </label>
            <select
              id="session-role-filter"
              className="form-input"
              value={roleFilter}
              onChange={(event) => updateFilter('role', event.target.value)}
            >
              {ROLE_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {hasFilters ? (
          <button type="button" className="btn btn-secondary" onClick={() => setSearchParams({})}>
            <Icon name="close" size={14} />
            Clear filters
          </button>
        ) : null}
      </div>

      {notice ? <div className="state-block state-success">{notice}</div> : null}
      {loading ? <LoadingState label="Loading sessions…" /> : null}
      {error ? <ErrorBanner error={error} onRetry={load} /> : null}
      {actionError ? <ErrorBanner error={actionError} /> : null}
      {!loading && !error && sessions?.length === 0 ? (
        <EmptyState
          icon="sessions"
          label={hasFilters ? 'No sessions match these filters.' : 'No sessions to show.'}
        />
      ) : null}

      {!loading && !error && sessions?.length > 0 ? (
        <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Session</th>
              <th>Room &amp; instructor</th>
              <th>Occupancy</th>
              <th className="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => {
              const capacityFull = session.bookedCount !== undefined && session.bookedCount >= session.capacity;
              return (
                <tr key={session.id}>
                  <td>
                    <div className="cell-identity">
                      <span className="cell-identity-primary">
                        {classById[session.classId]?.title ?? `#${session.classId}`}
                      </span>
                      <span className="cell-identity-secondary">
                        {new Date(session.startsAt).toLocaleString(undefined, {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="metadata-chip">
                      <Icon name="sessions" size={13} />
                      {roomById[session.roomId]?.name ?? `#${session.roomId}`}
                    </span>
                    <span className="metadata-chip">
                      <Icon name="users" size={13} />
                      {instructorById[session.primaryInstructorId]?.fullName ?? `#${session.primaryInstructorId}`}
                    </span>
                  </td>
                  <td>
                    {session.bookedCount !== undefined ? (
                      <span className={`badge ${capacityFull ? 'tone-amber' : 'tone-gray'}`}>
                        {session.bookedCount} / {session.capacity}
                      </span>
                    ) : (
                      <span className="badge tone-gray">— / {session.capacity}</span>
                    )}
                  </td>
                  <td className="col-actions">
                  <div className="table-actions">
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
                          <Icon name="edit" size={13} />
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost-danger btn-small"
                          onClick={() => setDeleteTarget(session)}
                        >
                          <Icon name="trash" size={13} />
                          Delete
                        </button>
                      </>
                    ) : null}
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
          title={modal === 'create' ? 'Create session' : 'Edit session'}
          subtitle={
            modal === 'create'
              ? 'Schedule a new one-off session.'
              : `Editing session #${modal.id}.`
          }
          onClose={() => setModal(null)}
        >
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
