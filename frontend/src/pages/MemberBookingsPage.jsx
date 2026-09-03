import { useEffect, useState } from 'react';

import { cancelMemberBooking, fetchMemberBookings } from '../api/memberPortal.js';
import { StatusBadge } from '../components/Badge.jsx';
import { ConfirmDialog } from '../components/Modal.jsx';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';

const CANCELLABLE = new Set(['booked', 'waitlisted']);

function formatSessionTime(startsAt) {
  return new Date(startsAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatBookedAt(bookedAt) {
  return new Date(bookedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * "My bookings" — the authenticated member's own bookings only.
 * `GET /api/member/bookings` is already scoped server-side to the caller's
 * linked member (see `routes/memberBookings.js`); this page has no filter
 * or parameter that could widen that. Cancellation reuses the exact same
 * `cancelBookingInTransaction` domain logic the staff booking routes call —
 * this page just triggers it and reflects the result.
 */
export function MemberBookingsPage() {
  const [bookings, setBookings] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelError, setCancelError] = useState(null);
  const [cancelling, setCancelling] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    fetchMemberBookings()
      .then((data) => setBookings(data.bookings))
      .catch(setError)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleCancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      const result = await cancelMemberBooking(cancelTarget.id);
      setBookings((current) =>
        current.map((booking) => (booking.id === result.booking.id ? result.booking : booking)),
      );
      setCancelTarget(null);
    } catch (err) {
      setCancelError(err);
    } finally {
      setCancelling(false);
    }
  }

  if (loading) return <LoadingState label="Loading your bookings…" />;
  if (error) return <ErrorBanner error={error} onRetry={load} />;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>My bookings</h1>
          <p className="page-subtitle">Every session you've booked, and its current status.</p>
        </div>
      </div>

      {bookings.length === 0 ? (
        <EmptyState
          icon="bookings"
          label="You haven't booked any sessions yet."
          action={{ label: 'Browse sessions', to: '/member/sessions' }}
        />
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Class</th>
                <th>Session</th>
                <th>Status</th>
                <th>Booked</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((booking) => (
                <tr key={booking.id}>
                  <td>{booking.class.title}</td>
                  <td>{formatSessionTime(booking.session.startsAt)}</td>
                  <td>
                    <StatusBadge status={booking.status} />
                  </td>
                  <td>{formatBookedAt(booking.bookedAt)}</td>
                  <td className="col-actions">
                    {CANCELLABLE.has(booking.status) ? (
                      <button
                        type="button"
                        className="btn btn-ghost-danger btn-small"
                        onClick={() => setCancelTarget(booking)}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cancelTarget ? (
        <ConfirmDialog
          title="Cancel this booking?"
          message={`Cancel your booking for ${cancelTarget.class.title} on ${formatSessionTime(cancelTarget.session.startsAt)}?`}
          confirmLabel={cancelling ? 'Cancelling…' : 'Cancel booking'}
          danger
          onConfirm={handleCancel}
          onClose={() => setCancelTarget(null)}
        />
      ) : null}
      <ErrorBanner error={cancelError} onDismiss={() => setCancelError(null)} />
    </div>
  );
}
