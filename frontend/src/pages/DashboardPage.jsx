import { useEffect, useState } from 'react';

import { fetchDashboard } from '../api/dashboard.js';
import { StatusBadge } from '../components/Badge.jsx';
import { ErrorBanner, LoadingState } from '../components/States.jsx';

const STATUS_ORDER = ['booked', 'waitlisted', 'cancelled', 'attended', 'no_show'];

function formatWeekStart(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function DashboardPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    fetchDashboard()
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  if (loading) return <LoadingState label="Loading dashboard…" />;
  if (error) return <ErrorBanner error={error} onRetry={load} />;
  if (!data) return null;

  // Every value rendered below (headline counts, statuses, classes, weeks)
  // comes straight from the server response — nothing here recomputes a
  // metric, it only lays the numbers out.
  const maxWeekCount = Math.max(1, ...data.attendancePerWeek.map((w) => w.count));

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Dashboard</h1>
          <p className="page-subtitle">A live snapshot of today's activity and the studio's recent trends.</p>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="Sessions today" value={data.headline.sessionsToday} />
        <StatCard label="Bookings made today" value={data.headline.bookingsToday} />
        <StatCard label="No-shows this week" value={data.headline.noShowsThisWeek} />
        <StatCard label="Members currently waitlisted" value={data.headline.membersWaitlisted} />
      </div>

      <div className="dashboard-grid">
        <section className="card">
          <h2>Bookings by status</h2>
          <div className="table-scroll">
          <table className="table">
            <tbody>
              {STATUS_ORDER.map((status) => (
                <tr key={status}>
                  <td>
                    <StatusBadge status={status} />
                  </td>
                  <td className="numeric">{data.bookingsByStatus[status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </section>

        <section className="card">
          <h2>Bookings by class</h2>
          {data.bookingsByClass.length === 0 ? (
            <p className="muted">No bookings yet.</p>
          ) : (
            <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Class</th>
                  <th className="numeric">Bookings</th>
                </tr>
              </thead>
              <tbody>
                {data.bookingsByClass.map((row) => (
                  <tr key={row.classId}>
                    <td>{row.classTitle}</td>
                    <td className="numeric">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </section>

        <section className="card dashboard-chart">
          <h2>Attendance — last 8 weeks</h2>
          <div className="bar-chart">
            {data.attendancePerWeek.map((week) => (
              <div className="bar-chart-column" key={week.weekStart}>
                <div className="bar-chart-value">{week.count}</div>
                <div
                  className="bar-chart-bar"
                  style={{ height: `${(week.count / maxWeekCount) * 100}%` }}
                />
                <div className="bar-chart-label">{formatWeekStart(week.weekStart)}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
