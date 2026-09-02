import { useEffect, useState } from 'react';

import { dismissMembershipAlert, fetchExpiringAlerts } from '../api/members.js';
import { Badge } from '../components/Badge.jsx';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';

function daysLabel(days) {
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
  if (days === 0) return 'Today';
  return `In ${days} day${days === 1 ? '' : 's'}`;
}

export function AlertsPage() {
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dismissingId, setDismissingId] = useState(null);
  const [dismissError, setDismissError] = useState(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchExpiringAlerts()
      .then((data) => setAlerts(data.alerts))
      .catch(setError)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleDismiss(memberId) {
    setDismissError(null);
    setDismissingId(memberId);
    try {
      await dismissMembershipAlert(memberId);
      // The server is authoritative about whether the alert still exists —
      // re-fetch the list rather than locally toggling a "dismissed" flag.
      load();
    } catch (err) {
      setDismissError(err);
    } finally {
      setDismissingId(null);
    }
  }

  return (
    <div>
      <h1>Membership expiry alerts</h1>
      <p className="muted">
        Members whose membership has expired, or expires within the next seven days.
      </p>

      {loading ? <LoadingState label="Loading alerts…" /> : null}
      {error ? <ErrorBanner error={error} onRetry={load} /> : null}
      {dismissError ? <ErrorBanner error={dismissError} /> : null}
      {!loading && !error && alerts?.length === 0 ? (
        <EmptyState label="No members are currently within the alert window." />
      ) : null}

      {!loading && !error && alerts?.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Expires</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {alerts.map((alert) => (
              <tr key={alert.memberId}>
                <td>{alert.fullName}</td>
                <td>{alert.email}</td>
                <td>{alert.membershipExpiresOn}</td>
                <td>
                  <Badge tone={alert.isExpired ? 'tone-red' : 'tone-amber'}>
                    {alert.isExpired ? 'Expired' : 'Expiring soon'} · {daysLabel(alert.daysUntilExpiry)}
                  </Badge>
                </td>
                <td className="table-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={dismissingId === alert.memberId}
                    onClick={() => handleDismiss(alert.memberId)}
                  >
                    {dismissingId === alert.memberId ? 'Dismissing…' : 'Dismiss'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
