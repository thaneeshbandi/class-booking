import { useEffect, useState } from 'react';

import { dismissMembershipAlert, fetchExpiringAlerts } from '../api/members.js';
import { Badge } from '../components/Badge.jsx';
import { Icon } from '../components/Icon.jsx';
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

  const expiredCount = alerts?.filter((a) => a.isExpired).length ?? 0;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Membership expiry alerts</h1>
          <p className="page-subtitle">
            Members whose membership has expired, or expires within the next seven days.
          </p>
        </div>
      </div>

      {loading ? <LoadingState label="Loading alerts…" /> : null}
      {error ? <ErrorBanner error={error} onRetry={load} /> : null}
      {dismissError ? <ErrorBanner error={dismissError} /> : null}
      {!loading && !error && alerts?.length === 0 ? (
        <EmptyState icon="check" label="No members are currently within the alert window." />
      ) : null}

      {!loading && !error && alerts?.length > 0 ? (
        <>
          <div className="alert-summary">
            <span className="alert-summary-icon" aria-hidden="true">
              <Icon name="alerts" size={20} />
            </span>
            <span>
              <strong>
                {alerts.length} membership{alerts.length === 1 ? '' : 's'}
              </strong>{' '}
              need attention
              {expiredCount > 0 ? (
                <span className="muted">
                  {' '}
                  · {expiredCount} already expired
                </span>
              ) : null}
            </span>
          </div>

          <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Expires</th>
                <th>Status</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => (
                <tr key={alert.memberId} className={alert.isExpired ? 'row-severe' : undefined}>
                  <td>
                    <div className="cell-identity">
                      <span className="cell-identity-primary">{alert.fullName}</span>
                      <span className="cell-identity-secondary">{alert.email}</span>
                    </div>
                  </td>
                  <td>
                    <span className="metadata-chip">
                      <Icon name="calendar" size={13} />
                      {alert.membershipExpiresOn}
                    </span>
                  </td>
                  <td>
                    <Badge tone={alert.isExpired ? 'tone-red' : 'tone-amber'}>
                      {alert.isExpired ? 'Expired' : 'Expiring soon'} · {daysLabel(alert.daysUntilExpiry)}
                    </Badge>
                  </td>
                  <td className="col-actions">
                  <div className="table-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={dismissingId === alert.memberId}
                      onClick={() => handleDismiss(alert.memberId)}
                    >
                      <Icon name="check" size={13} />
                      {dismissingId === alert.memberId ? 'Dismissing…' : 'Dismiss'}
                    </button>
                  </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
