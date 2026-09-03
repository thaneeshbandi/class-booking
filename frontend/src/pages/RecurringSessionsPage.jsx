import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { fetchClasses } from '../api/classes.js';
import { fetchRooms } from '../api/rooms.js';
import { generateRecurringSessions } from '../api/sessions.js';
import { fetchInstructors } from '../api/users.js';
import { Badge } from '../components/Badge.jsx';
import { Icon } from '../components/Icon.jsx';
import { LoadingState, ErrorBanner as ReferenceErrorBanner } from '../components/States.jsx';

// 0=Sunday..6=Saturday — the exact convention `POST /api/sessions/recurring`
// expects (`Date.prototype.getDay()`).
const WEEKDAYS = [
  { value: 0, label: 'Sun', full: 'Sunday' },
  { value: 1, label: 'Mon', full: 'Monday' },
  { value: 2, label: 'Tue', full: 'Tuesday' },
  { value: 3, label: 'Wed', full: 'Wednesday' },
  { value: 4, label: 'Thu', full: 'Thursday' },
  { value: 5, label: 'Fri', full: 'Friday' },
  { value: 6, label: 'Sat', full: 'Saturday' },
];
const WEEKDAY_FULL_NAME = Object.fromEntries(WEEKDAYS.map((d) => [d.value, d.full]));

const SKIP_REASON_LABEL = {
  room_conflict: 'Room conflict',
  instructor_conflict: 'Instructor conflict',
  existing_session: 'Already exists',
};

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

/** Parses a `YYYY-MM-DD` value as UTC midnight so weekday arithmetic below
 * never shifts by a day depending on the browser's own timezone — this is
 * pure client-side candidate-counting for the preview only; the actual
 * instant each session is created at is still computed server-side in
 * `STUDIO_TIMEZONE`, unchanged by anything on this page. */
function parseIsoDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetweenInclusive(start, end) {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

/** Every weekday that occurs at least once in `[startDate, endDate]` — once
 * the range spans 7 or more days every weekday necessarily occurs, so this
 * only ever needs to check at most a handful of individual dates. */
function weekdaysCoveredByRange(startDate, endDate) {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start || !end || start > end) return new Set();
  const span = daysBetweenInclusive(start, end);
  if (span >= 7) return new Set([0, 1, 2, 3, 4, 5, 6]);
  const covered = new Set();
  const cursor = new Date(start);
  for (let i = 0; i < span; i += 1) {
    covered.add(cursor.getUTCDay());
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return covered;
}

/** How many candidate dates the current range/weekday selection would
 * produce — an estimate of what the server will *attempt*, not a promise of
 * what it will *create* (a candidate can still be skipped for a room/
 * instructor conflict or an exact duplicate, which is only knowable
 * server-side). Computed in O(1) via full-week counting rather than
 * iterating every day, so an absurdly wide date range stays instant. */
function countCandidates(startDate, endDate, weekdaySet) {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start || !end || start > end || weekdaySet.size === 0) return 0;
  const totalDays = daysBetweenInclusive(start, end);
  const fullWeeks = Math.floor(totalDays / 7);
  const remainder = totalDays % 7;
  let count = fullWeeks * weekdaySet.size;
  const cursor = new Date(start);
  cursor.setUTCDate(cursor.getUTCDate() + fullWeeks * 7);
  for (let i = 0; i < remainder; i += 1) {
    if (weekdaySet.has(cursor.getUTCDay())) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
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

  const dateRangeValid = useMemo(() => {
    const start = parseIsoDate(startDate);
    const end = parseIsoDate(endDate);
    return Boolean(start && end && start <= end);
  }, [startDate, endDate]);

  const coveredWeekdays = useMemo(
    () => (dateRangeValid ? weekdaysCoveredByRange(startDate, endDate) : new Set()),
    [startDate, endDate, dateRangeValid],
  );

  const weekdaySet = useMemo(() => new Set(weekdays), [weekdays]);

  const candidateCount = useMemo(
    () => (dateRangeValid ? countCandidates(startDate, endDate, weekdaySet) : 0),
    [startDate, endDate, weekdaySet, dateRangeValid],
  );

  const isSingleDay = startDate === endDate;
  const singleDayWeekday = isSingleDay && dateRangeValid ? parseIsoDate(startDate).getUTCDay() : null;

  // The one client-computable reason "Generate sessions" would fail outright
  // — server-side conflicts/duplicates are not knowable here and are left to
  // the actual request and its Created/Skipped breakdown below.
  let validationMessage = null;
  if (!dateRangeValid) {
    validationMessage = 'End date must be on or after the start date.';
  } else if (weekdays.length === 0) {
    validationMessage = 'Select at least one weekday.';
  } else if (candidateCount === 0 && isSingleDay && singleDayWeekday !== null) {
    validationMessage = `${startDate} is a ${WEEKDAY_FULL_NAME[singleDayWeekday]}, but ${WEEKDAY_FULL_NAME[singleDayWeekday]} isn't selected below. Select ${WEEKDAY_FULL_NAME[singleDayWeekday]}, or change the date.`;
  } else if (candidateCount === 0) {
    validationMessage =
      'No date in this range falls on a selected weekday. Widen the date range or choose a different weekday.';
  }

  const canSubmit = !submitting && !validationMessage;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSubmit) return;
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
  if (referenceError) return <ReferenceErrorBanner error={referenceError} />;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Generate recurring sessions</h1>
          <p className="page-subtitle">
            Create a run of sessions on a weekly pattern — pick a date range and the weekdays it
            repeats on.
          </p>
        </div>
        <Link to="/sessions" className="btn btn-secondary">
          Back to sessions
        </Link>
      </div>

      <form className="card" onSubmit={handleSubmit}>
        {error ? (
          <div className="state-block state-error" role="alert">
            {/* The backend's own validation/business-rule message is already
             * plain English (e.g. "No candidate dates fall within the given
             * range and weekdays.") — shown as-is, without an HTTP status
             * code prefix, since that reads as a raw error code to a studio
             * staff member rather than useful information. */}
            {error.message || 'Something went wrong. Please try again.'}
          </div>
        ) : null}

        <div className="form-section">
          <h3 className="form-section-title">Session details</h3>
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
        </div>

        <div className="form-section">
          <h3 className="form-section-title">Date range</h3>
          <div className="form-row">
            <div>
              <label className="form-label" htmlFor="rec-start-date">
                Start date
              </label>
              <input
                id="rec-start-date"
                type="date"
                className={`form-input${!dateRangeValid ? ' has-error' : ''}`}
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
                className={`form-input${!dateRangeValid ? ' has-error' : ''}`}
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                required
              />
            </div>
          </div>
          <p className="form-help">
            {dateRangeValid
              ? isSingleDay
                ? `${startDate} is a ${WEEKDAY_FULL_NAME[singleDayWeekday]}.`
                : `This range covers: ${WEEKDAYS.filter((d) => coveredWeekdays.has(d.value))
                    .map((d) => d.full)
                    .join(', ')}.`
              : 'Pick an end date on or after the start date.'}
          </p>
        </div>

        <div className="form-section">
          <h3 className="form-section-title">Schedule</h3>
          <label className="form-label" htmlFor="rec-time">
            Local start time
          </label>
          <input
            id="rec-time"
            type="time"
            className="form-input form-input-inline"
            value={localStartTime}
            onChange={(event) => setLocalStartTime(event.target.value)}
            required
          />

          <label className="form-label">
            Repeats on
            <span className="form-label-hint"> — at least one selected weekday must fall inside the date range above</span>
          </label>
          <div className="weekday-picker">
            {WEEKDAYS.map((day) => (
              <label
                key={day.value}
                className={`weekday-chip${
                  dateRangeValid && coveredWeekdays.has(day.value) ? ' is-covered' : ''
                }`}
                title={
                  dateRangeValid && !coveredWeekdays.has(day.value)
                    ? `${day.full} does not occur in the selected date range`
                    : undefined
                }
              >
                <input
                  type="checkbox"
                  checked={weekdays.includes(day.value)}
                  onChange={() => toggleWeekday(day.value)}
                />
                {day.label}
              </label>
            ))}
          </div>
        </div>

        <div className="form-section form-section-last">
          <h3 className="form-section-title">Overrides</h3>
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
              <p className="form-help">Defaults from the class if left blank.</p>
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
              <p className="form-help">Defaults from the class if left blank.</p>
            </div>
          </div>
        </div>

        <div className={`preview-card${validationMessage ? ' is-warning' : ''}`}>
          <span className="preview-card-icon" aria-hidden="true">
            <Icon name={validationMessage ? 'warning' : 'calendar'} size={18} />
          </span>
          {validationMessage ? (
            <div>
              <div className="preview-card-title">Can't generate yet</div>
              <div className="preview-card-body">{validationMessage}</div>
            </div>
          ) : (
            <div>
              <div className="preview-card-title">
                {candidateCount} session{candidateCount === 1 ? '' : 's'} will be generated
              </div>
              {candidateCount > 0 ? (
                <div className="preview-card-body">
                  {startDate} – {endDate}, on{' '}
                  {WEEKDAYS.filter((d) => weekdays.includes(d.value))
                    .map((d) => d.full)
                    .join(', ')}
                  . Some may still be skipped if they conflict with an existing session.
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
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
              <div className="table-scroll">
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
              </div>
            )}
          </section>

          <section className="card">
            <h2>Skipped ({result.skipped.length})</h2>
            {result.skipped.length === 0 ? (
              <p className="muted">No candidates were skipped.</p>
            ) : (
              <div className="table-scroll">
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
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
