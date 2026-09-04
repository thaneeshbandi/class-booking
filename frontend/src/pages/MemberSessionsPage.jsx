import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { fetchClasses } from '../api/classes.js';
import { createMemberBooking, fetchMemberSessions } from '../api/memberPortal.js';
import { Icon } from '../components/Icon.jsx';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';

const AVAILABILITY_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'available', label: 'Available' },
  { value: 'full', label: 'Fully booked' },
  { value: 'mine', label: 'My booked sessions' },
];

function formatSessionTime(startsAt) {
  return new Date(startsAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Member session browsing + booking. `POST /api/member/bookings` derives
 * the booking member from the authenticated user server-side — this page
 * never sends a member id, only the session being booked (see
 * `routes/memberBookings.js`); the same capacity/waitlist rule staff
 * bookings use decides booked-vs-waitlisted, not anything computed here.
 *
 * Each session's own booking state comes from `myBooking` on that session
 * object — `GET /api/member/sessions` now reports it directly, keyed
 * implicitly by each session's own id in the array. This replaced a bug: an
 * earlier version tracked "the session I most recently booked" in one
 * shared `justBookedId` scalar, which a second booking simply overwrote,
 * silently reverting the first session's card back to "Book". There is no
 * shared scalar here for booking state — it is read straight off the
 * session that owns it, so booking or cancelling one session can never
 * affect how any other session's card renders. See `docs/decisions.md`.
 */
export function MemberSessionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const classId = searchParams.get('classId') ?? '';
  const dateFrom = searchParams.get('dateFrom') ?? '';
  const dateTo = searchParams.get('dateTo') ?? '';
  const availability = searchParams.get('availability') ?? '';

  const [sessions, setSessions] = useState(null);
  const [classes, setClasses] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // Which sessions currently have an in-flight booking request — a Set
  // keyed by session id, not a single scalar, so two different cards can
  // never be confused with each other while both mid-request.
  const [bookingInFlight, setBookingInFlight] = useState(() => new Set());
  const [bookingError, setBookingError] = useState(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchMemberSessions({ classId, dateFrom, dateTo, availability })
      .then((data) => setSessions(data.sessions))
      .catch(setError)
      .finally(() => setLoading(false));
  }

  // Refetches from the server on every filter change — the authoritative
  // source for booking state (`myBooking`) is always what the backend just
  // returned, never something reconstructed or carried over client-side.
  useEffect(load, [classId, dateFrom, dateTo, availability]);

  // The class filter's own options — a small, separate, one-time fetch
  // (reuses the same `GET /api/classes` every other authenticated role
  // already has read access to; see `routes/classes.js`), not re-run on
  // every filter change.
  useEffect(() => {
    fetchClasses()
      .then((data) => setClasses(data.classes))
      .catch(() => {
        // A failed class-list fetch degrades to "no class filter options"
        // rather than blocking the page — the session list itself still
        // loads and works without it.
      });
  }, []);

  function updateFilter(key, value) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  }

  const hasFilters = Boolean(classId || dateFrom || dateTo || availability);

  async function handleBook(sessionId) {
    setBookingInFlight((current) => new Set(current).add(sessionId));
    setBookingError(null);
    try {
      const result = await createMemberBooking(sessionId);
      // Updates only the one session that was just booked, from the
      // server's own response — every other session's entry in the array
      // keeps the exact object it already had, untouched.
      setSessions((current) =>
        current.map((session) => {
          if (session.id !== sessionId) return session;
          const bookedCount =
            result.booking.status === 'booked' ? session.bookedCount + 1 : session.bookedCount;
          return {
            ...session,
            bookedCount,
            isFull: bookedCount >= session.capacity,
            myBooking: { id: result.booking.id, status: result.booking.status },
          };
        }),
      );
    } catch (err) {
      setBookingError(err);
    } finally {
      setBookingInFlight((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  }

  if (loading) return <LoadingState label="Loading sessions…" />;
  if (error) return <ErrorBanner error={error} onRetry={load} />;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Sessions</h1>
          <p className="page-subtitle">Browse upcoming sessions and book your spot.</p>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-field">
          <label className="form-label" htmlFor="member-session-class-filter">
            Class
          </label>
          <select
            id="member-session-class-filter"
            className="form-input"
            value={classId}
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
          <label className="form-label" htmlFor="member-session-date-from">
            From
          </label>
          <input
            id="member-session-date-from"
            type="date"
            className="form-input"
            value={dateFrom}
            onChange={(event) => updateFilter('dateFrom', event.target.value)}
          />
        </div>
        <div className="filter-field">
          <label className="form-label" htmlFor="member-session-date-to">
            To
          </label>
          <input
            id="member-session-date-to"
            type="date"
            className="form-input"
            value={dateTo}
            onChange={(event) => updateFilter('dateTo', event.target.value)}
          />
        </div>
        <div className="filter-field">
          <label className="form-label" htmlFor="member-session-availability-filter">
            Availability
          </label>
          <select
            id="member-session-availability-filter"
            className="form-input"
            value={availability}
            onChange={(event) => updateFilter('availability', event.target.value)}
          >
            {AVAILABILITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {hasFilters ? (
          <button type="button" className="btn btn-secondary" onClick={() => setSearchParams({})}>
            <Icon name="close" size={14} />
            Clear filters
          </button>
        ) : null}
      </div>

      <ErrorBanner error={bookingError} onDismiss={() => setBookingError(null)} />

      {sessions.length === 0 ? (
        <EmptyState
          icon="sessions"
          label={hasFilters ? 'No sessions match these filters.' : 'No upcoming sessions are scheduled right now.'}
        />
      ) : (
        <div className="member-session-grid">
          {sessions.map((session) => {
            const isBooked = session.myBooking?.status === 'booked';
            const isWaitlisted = session.myBooking?.status === 'waitlisted';
            const isSubmitting = bookingInFlight.has(session.id);
            return (
              <div className="card member-session-card" key={session.id}>
                <div className="member-session-card-header">
                  <h3>{session.class.title}</h3>
                  <span className="badge tone-gray">{session.class.discipline}</span>
                </div>
                <div className="member-session-meta">
                  <span>
                    <Icon name="calendar" size={14} />
                    {formatSessionTime(session.startsAt)}
                  </span>
                  <span>
                    <Icon name="clock" size={14} />
                    {session.durationMinutes} min
                  </span>
                  <span>
                    <Icon name="classes" size={14} />
                    {session.room.name}
                  </span>
                  <span>
                    <Icon name="users" size={14} />
                    {session.instructor.fullName}
                  </span>
                </div>
                <div className="member-session-card-footer">
                  <span className={`badge ${session.isFull ? 'tone-amber' : 'tone-green'}`}>
                    {session.isFull ? 'Full — joins waitlist' : `${session.capacity - session.bookedCount} spots left`}
                  </span>
                  {isBooked || isWaitlisted ? (
                    <span className={`badge ${isBooked ? 'tone-blue' : 'tone-amber'}`}>
                      <Icon name="check" size={13} />
                      {isBooked ? 'Booked' : 'Waitlisted'}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-small"
                      disabled={isSubmitting}
                      onClick={() => handleBook(session.id)}
                    >
                      {isSubmitting ? 'Booking…' : session.isFull ? 'Join waitlist' : 'Book'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
