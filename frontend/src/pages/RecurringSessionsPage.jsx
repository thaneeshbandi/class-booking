import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { fetchClasses } from '../api/classes.js';
import { fetchRooms } from '../api/rooms.js';
import { generateRecurringSessions } from '../api/sessions.js';
import { fetchInstructors } from '../api/users.js';
import { Badge } from '../components/Badge.jsx';
import { ErrorBanner, LoadingState } from '../components/States.jsx';

// 0=Sunday..6=Saturday — the exact convention `POST /api/sessions/recurring`
// expects (`Date.prototype.getDay()`).
const WEEKDAYS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

const SKIP_REASON_LABEL = {
  room_conflict: 'Room conflict',
  instructor_conflict: 'Instructor conflict',
  existing_session: 'Already exists',
};

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function RecurringSessionsPage() {
  const [classes, setClasses] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [instructors, setInstructors] = useState([]);
  const [loadingReference, setLoadingReference] = useState(true);
  const [referenceError, setReferenceError] = useState(null);

  const [classId, setClassId] = useState('');
  const [primaryInstructorId, setPrimaryInstructorId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [startDate, setStartDate] = useState(todayIsoDate());
  const [endDate, setEndDate] = useState(todayIsoDate());
  const [localStartTime, setLocalStartTime] = useState('09:00');
  const [weekdays, setWeekdays] = useState([1]);
  const [durationMinutes, setDurationMinutes] = useState('');
  const [capacity, setCapacity] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    setLoadingReference(true);
    Promise.all([fetchClasses(), fetchRooms(), fetchInstructors()])
      .then(([classesData, roomsData, instructorsData]) => {
        setClasses(classesData.classes);
        setRooms(roomsData.rooms);
        setInstructors(instructorsData.users);
        setClassId(classesData.classes[0]?.id ?? '');
        setRoomId(roomsData.rooms[0]?.id ?? '');
        setPrimaryInstructorId(instructorsData.users[0]?.id ?? '');
      })
      .catch(setReferenceError)
      .finally(() => setLoadingReference(false));
  }, []);

  function toggleWeekday(value) {
    setWeekdays((current) =>
      current.includes(value) ? current.filter((d) => d !== value) : [...current, value].sort(),
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const body = {
        classId: Number(classId),
        primaryInstructorId: Number(primaryInstructorId),
        roomId: Number(roomId),
        startDate,
        endDate,
        localStartTime,
        weekdays,
        ...(durationMinutes ? { durationMinutes: Number(durationMinutes) } : {}),
        ...(capacity ? { capacity: Number(capacity) } : {}),
      };
      const data = await generateRecurringSessions(body);
      setResult(data);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (loadingReference) return <LoadingState label="Loading form data…" />;
  if (referenceError) return <ErrorBanner error={referenceError} />;

  return (
    <div>
      <div className="page-header">
        <h1>Generate recurring sessions</h1>
        <Link to="/sessions" className="btn btn-secondary">
          Back to sessions
        </Link>
      </div>

      <form className="card" onSubmit={handleSubmit}>
        <ErrorBanner error={error} />

        <label className="form-label" htmlFor="rec-class">
          Class
        </label>
        <select
          id="rec-class"
          className="form-input"
          value={classId}
          onChange={(event) => setClassId(event.target.value)}
          required
        >
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>

        <div className="form-row">
          <div>
            <label className="form-label" htmlFor="rec-instructor">
              Primary instructor
            </label>
            <select
              id="rec-instructor"
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
            <label className="form-label" htmlFor="rec-room">
              Room
            </label>
            <select
              id="rec-room"
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

        <div className="form-row">
          <div>
            <label className="form-label" htmlFor="rec-start-date">
              Start date
            </label>
            <input
              id="rec-start-date"
              type="date"
              className="form-input"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              required
            />
          </div>
          <div>
            <label className="form-label" htmlFor="rec-end-date">
              End date
            </label>
            <input
              id="rec-end-date"
              type="date"
              className="form-input"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              required
            />
          </div>
          <div>
            <label className="form-label" htmlFor="rec-time">
              Local start time
            </label>
            <input
              id="rec-time"
              type="time"
              className="form-input"
              value={localStartTime}
              onChange={(event) => setLocalStartTime(event.target.value)}
              required
            />
          </div>
        </div>

        <label className="form-label">Repeats on</label>
        <div className="weekday-picker">
          {WEEKDAYS.map((day) => (
            <label key={day.value} className="weekday-chip">
              <input
                type="checkbox"
                checked={weekdays.includes(day.value)}
                onChange={() => toggleWeekday(day.value)}
              />
              {day.label}
            </label>
          ))}
        </div>

        <div className="form-row">
          <div>
            <label className="form-label" htmlFor="rec-duration">
              Duration (minutes, optional)
            </label>
            <input
              id="rec-duration"
              type="number"
              min="1"
              className="form-input"
              value={durationMinutes}
              onChange={(event) => setDurationMinutes(event.target.value)}
            />
          </div>
          <div>
            <label className="form-label" htmlFor="rec-capacity">
              Capacity (optional)
            </label>
            <input
              id="rec-capacity"
              type="number"
              min="1"
              className="form-input"
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
            />
          </div>
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={submitting || weekdays.length === 0}>
            {submitting ? 'Generating…' : 'Generate sessions'}
          </button>
        </div>
      </form>

      {result ? (
        <div className="dashboard-grid">
          <section className="card">
            <h2>Created ({result.created.length})</h2>
            {result.created.length === 0 ? (
              <p className="muted">No sessions were created.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Starts at</th>
                  </tr>
                </thead>
                <tbody>
                  {result.created.map((session) => (
                    <tr key={session.id}>
                      <td>{session.date}</td>
                      <td>{new Date(session.startsAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card">
            <h2>Skipped ({result.skipped.length})</h2>
            {result.skipped.length === 0 ? (
              <p className="muted">No candidates were skipped.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.skipped.map((skip, i) => (
                    <tr key={i}>
                      <td>{skip.date}</td>
                      <td>
                        <Badge tone="tone-amber">{SKIP_REASON_LABEL[skip.reason] ?? skip.reason}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
