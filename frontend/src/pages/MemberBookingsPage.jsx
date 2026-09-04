import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { fetchClasses } from '../api/classes.js';
import { cancelMemberBooking, fetchMemberBookings } from '../api/memberPortal.js';
import { STATUS_LABEL, StatusBadge } from '../components/Badge.jsx';
import { Icon } from '../components/Icon.jsx';
import { ConfirmDialog } from '../components/Modal.jsx';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';

const CANCELLABLE = new Set(['booked', 'waitlisted']);
const STATUSES = ['booked', 'waitlisted', 'cancelled', 'attended', 'no_show'];

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
 * linked member (see `routes/memberBookings.js`); every filter below is
 * additive on top of that scope, never a way to widen it — status, class,
 * and date range are all applied server-side, ANDed onto the caller's own
 * `member_id`. Cancellation reuses the exact same `cancelBookingInTransaction`
 * domain logic the staff booking routes call — this page just triggers it
 * and reflects the result.
 */
export function MemberBookingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const classId = searchParams.get('classId') ?? '';
  const dateFrom = searchParams.get('dateFrom') ?? '';
  const dateTo = searchParams.get('dateTo') ?? '';

  const [bookings, setBookings] = useState(null);
  const [classes, setClasses] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelError, setCancelError] = useState(null);
  const [cancelling, setCancelling] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    fetchMemberBookings({ status, classId, dateFrom, dateTo })
      .then((data) => setBookings(data.bookings))
      .catch(setError)
      .finally(() => setLoading(false));
  }

  useEffect(load, [status, classId, dateFrom, dateTo]);

  useEffect(() => {
    fetchClasses()
      .then((data) => setClasses(data.classes))
      .catch(() => {
        // Degrades to "no class filter options" — the bookings list itself
        // still loads and works without it.
      });
  }, []);

  function updateFilter(key, value) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  }

  const hasFilters = Boolean(status || classId || dateFrom || dateTo);

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

      <div className="filter-bar">
        <div className="filter-field">
          <label className="form-label" htmlFor="member-booking-status-filter">
            Status
          </label>
          <select
            id="member-booking-status-filter"
            className="form-input"
            value={status}
            onChange={(event) => updateFilter('status', event.target.value)}
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label className="form-label" htmlFor="member-booking-class-filter">
            Class
          </label>
          <select
            id="member-booking-class-filter"
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
          <label className="form-label" htmlFor="member-booking-date-from">
            From
          </label>
          <input
            id="member-booking-date-from"
            type="date"
            className="form-input"
            value={dateFrom}
            onChange={(event) => updateFilter('dateFrom', event.target.value)}
          />
        </div>
        <div className="filter-field">
          <label className="form-label" htmlFor="member-booking-date-to">
            To
          </label>
          <input
            id="member-booking-date-to"
            type="date"
            className="form-input"
            value={dateTo}
            onChange={(event) => updateFilter('dateTo', event.target.value)}
          />
        </div>
        {hasFilters ? (
          <button type="button" className="btn btn-secondary" onClick={() => setSearchParams({})}>
            <Icon name="close" size={14} />
            Clear filters
          </button>
        ) : null}
      </div>

      {bookings.length === 0 ? (
        <EmptyState
          icon="bookings"
          label={
            hasFilters
              ? 'No bookings match these filters.'
              : "You haven't booked any sessions yet."
          }
          action={hasFilters ? { label: 'Clear filters', onClick: () => setSearchParams({}) } : { label: 'Browse sessions', to: '/member/sessions' }}
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
