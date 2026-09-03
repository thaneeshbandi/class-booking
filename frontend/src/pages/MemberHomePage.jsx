import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { fetchMemberBookings } from '../api/memberPortal.js';
import { StatusBadge } from '../components/Badge.jsx';
import { Icon } from '../components/Icon.jsx';
import { membershipStatus } from '../components/membershipStatus.js';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';

function greetingForHour(hour) {
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

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
 * The member portal's own landing page — a real replacement for the old
 * placeholder `WelcomePage`, now that member self-service booking exists.
 * Every value shown here (membership expiry, bookings) is exactly what
 * `GET /api/member/bookings` returned; this page only lays it out, it never
 * decides membership status or booking eligibility itself — see
 * `docs/decisions.md`.
 */
export function MemberHomePage() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    fetchMemberBookings().then(setData).catch(setError).finally(() => setLoading(false));
  }

  useEffect(load, []);

  const firstName = user.fullName.split(' ')[0];

  if (loading) return <LoadingState label="Loading your home…" />;
  if (error) return <ErrorBanner error={error} onRetry={load} />;
  if (!data) return null;

  const status = membershipStatus(data.membership.expiresOn);
  const now = Date.now();
  const upcoming = data.bookings
    .filter((b) => ['booked', 'waitlisted'].includes(b.status) && new Date(b.session.startsAt).getTime() >= now)
    .sort((a, b) => new Date(a.session.startsAt) - new Date(b.session.startsAt))
    .slice(0, 5);

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>
            {greetingForHour(new Date().getHours())}, {firstName}
          </h1>
          <p className="page-subtitle">Here's what's coming up for you.</p>
        </div>
      </div>

      <div className="dashboard-grid">
        <section className="card">
          <h2>Your membership</h2>
          <div className="membership-summary">
            <span className={`badge ${status.tone}`}>{status.label}</span>
            <p className="muted">{status.detail}</p>
          </div>
          {status.expired ? (
            <p className="muted">
              You can still browse sessions, but new bookings are on hold until your membership is
              renewed by the studio.
            </p>
          ) : null}
        </section>

        <section className="card">
          <h2>Quick actions</h2>
          <div className="quick-actions">
            <Link to="/member/sessions" className="btn btn-primary btn-block">
              <Icon name="sessions" size={16} />
              Browse sessions
            </Link>
            <Link to="/member/bookings" className="btn btn-secondary btn-block">
              <Icon name="bookings" size={16} />
              View my bookings
            </Link>
            <Link to="/profile" className="btn btn-secondary btn-block">
              <Icon name="users" size={16} />
              Profile
            </Link>
          </div>
        </section>
      </div>

      <section className="card">
        <h2>Upcoming bookings</h2>
        {upcoming.length === 0 ? (
          <EmptyState
            icon="calendar"
            label="No upcoming bookings yet."
            action={{ label: 'Browse sessions', to: '/member/sessions' }}
          />
        ) : (
          <ul className="member-booking-list">
            {upcoming.map((booking) => (
              <li key={booking.id} className="member-booking-row">
                <div>
                  <div className="member-booking-class">{booking.class.title}</div>
                  <div className="muted">{formatSessionTime(booking.session.startsAt)}</div>
                </div>
                <StatusBadge status={booking.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
