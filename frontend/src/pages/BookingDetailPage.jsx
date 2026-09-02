import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { fetchBooking } from '../api/bookings.js';
import { StatusBadge } from '../components/Badge.jsx';
import { ErrorBanner, LoadingState } from '../components/States.jsx';

const EVENT_LABEL = {
  created: 'Created',
  status_changed: 'Status changed',
  note: 'Note added',
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
        <h1>Booking #{booking.id}</h1>
        <Link to={`/sessions/${booking.sessionId}`} className="btn btn-secondary">
          View session
        </Link>
      </div>

      <section className="card">
        <dl className="detail-list">
          <dt>Member</dt>
          <dd>
            {booking.member.fullName} ({booking.member.email})
          </dd>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={booking.status} />
          </dd>
          <dt>Booked at</dt>
          <dd>{new Date(booking.createdAt).toLocaleString()}</dd>
        </dl>
      </section>

      <section className="card">
        <h2>History</h2>
        <p className="muted">
          An immutable record — nothing here can be edited or deleted after the fact.
        </p>
        <ul className="timeline">
          {events.map((event) => (
            <li key={event.id} className="timeline-item">
              <div className="timeline-marker" />
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
