import { useEffect, useState } from 'react';

import { createMemberBooking, fetchMemberSessions } from '../api/memberPortal.js';
import { Icon } from '../components/Icon.jsx';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';

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
 */
export function MemberSessionsPage() {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [bookingId, setBookingId] = useState(null);
  const [bookingError, setBookingError] = useState(null);
  const [justBookedId, setJustBookedId] = useState(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchMemberSessions()
      .then((data) => setSessions(data.sessions))
      .catch(setError)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleBook(sessionId) {
    setBookingId(sessionId);
    setBookingError(null);
    setJustBookedId(null);
    try {
      const result = await createMemberBooking(sessionId);
      setJustBookedId(sessionId);
      // Reflect the new booking's effect on capacity/availability without a
      // full reload — the row's own booked count/full state.
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                bookedCount: result.booking.status === 'booked' ? session.bookedCount + 1 : session.bookedCount,
                isFull: result.booking.status === 'booked' ? session.bookedCount + 1 >= session.capacity : session.isFull,
              }
            : session,
        ),
      );
    } catch (err) {
      setBookingError(err);
    } finally {
      setBookingId(null);
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

      <ErrorBanner error={bookingError} onDismiss={() => setBookingError(null)} />

      {sessions.length === 0 ? (
        <EmptyState icon="sessions" label="No upcoming sessions are scheduled right now." />
      ) : (
        <div className="member-session-grid">
          {sessions.map((session) => (
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
                {justBookedId === session.id ? (
                  <span className="badge tone-blue">
                    <Icon name="check" size={13} />
                    Booked
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    disabled={bookingId === session.id}
                    onClick={() => handleBook(session.id)}
                  >
                    {bookingId === session.id ? 'Booking…' : session.isFull ? 'Join waitlist' : 'Book'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
