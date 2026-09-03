import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { fetchBooking } from '../api/bookings.js';
import { StatusBadge } from '../components/Badge.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorBanner, LoadingState } from '../components/States.jsx';

const EVENT_LABEL = {
  created: 'Created',
  status_changed: 'Status changed',
  note: 'Note added',
};

const EVENT_ICON = {
  created: 'check',
  status_changed: 'chevronRight',
  note: 'edit',
};

export function BookingDetailPage() {
  const { id } = useParams();
  const [booking, setBooking] = useState(null);
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    fetchBooking(id)
      .then((data) => {
        setBooking(data.booking);
        setEvents(data.events);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }

  useEffect(load, [id]);

  if (loading) return <LoadingState label="Loading booking…" />;
  if (error) return <ErrorBanner error={error} onRetry={load} />;
  if (!booking) return null;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Booking #{booking.id}</h1>
          <p className="page-subtitle">{booking.member.fullName}</p>
        </div>
        <Link to={`/sessions/${booking.sessionId}`} className="btn btn-secondary">
          View session
        </Link>
      </div>

      <section className="card">
        <div className="session-summary-grid">
          <div className="session-summary-item">
            <span className="session-summary-icon">
              <Icon name="members" size={16} />
            </span>
            <div>
              <div className="session-summary-label">Member</div>
              <div className="session-summary-value">{booking.member.fullName}</div>
              <div className="cell-identity-secondary">{booking.member.email}</div>
            </div>
          </div>
          <div className="session-summary-item">
            <span className="session-summary-icon">
              <Icon name="alerts" size={16} />
            </span>
            <div>
              <div className="session-summary-label">Status</div>
              <StatusBadge status={booking.status} />
            </div>
          </div>
          <div className="session-summary-item">
            <span className="session-summary-icon">
              <Icon name="clock" size={16} />
            </span>
            <div>
              <div className="session-summary-label">Booked at</div>
              <div className="session-summary-value">{new Date(booking.createdAt).toLocaleString()}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>History</h2>
        <p className="muted">
          An immutable record — nothing here can be edited or deleted after the fact.
        </p>
        <ul className="timeline">
          {events.map((event) => (
            <li key={event.id} className="timeline-item">
              <div className="timeline-marker">
                <Icon name={EVENT_ICON[event.eventType] ?? 'inbox'} size={11} />
              </div>
              <div>
                <div className="timeline-title">
                  {EVENT_LABEL[event.eventType] ?? event.eventType}
                  {event.isAutomatic ? <span className="badge tone-gray">automatic</span> : null}
                </div>
                {event.eventType === 'status_changed' ? (
                  <div>
                    <StatusBadge status={event.fromStatus} /> → <StatusBadge status={event.toStatus} />
                  </div>
                ) : null}
                {event.eventType === 'created' ? (
                  <div>
                    <StatusBadge status={event.toStatus} />
                  </div>
                ) : null}
                {event.note ? <div className="timeline-note">“{event.note}”</div> : null}
                <div className="muted">{new Date(event.occurredAt).toLocaleString()}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
