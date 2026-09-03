import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { fetchDashboard } from '../api/dashboard.js';
import { StatusBadge } from '../components/Badge.jsx';
import { Icon } from '../components/Icon.jsx';
import { MetricCard } from '../components/MetricCard.jsx';
import { EmptyState, ErrorBanner, LoadingState } from '../components/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useAlertCount } from '../hooks/useAlertCount.js';

const STATUS_ORDER = ['booked', 'waitlisted', 'cancelled', 'attended', 'no_show'];

function formatWeekStart(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** The visitor's own local time of day — a client-side greeting only, never
 * a studio-timezone business value (every actual date/time computation in
 * this app stays server-side, in `STUDIO_TIMEZONE`, unchanged). */
function greetingForHour(hour) {
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function DashboardPage() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const alertCount = useAlertCount();

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
  const maxClassCount = Math.max(1, ...data.bookingsByClass.map((c) => c.count));
  const firstName = user.fullName.split(' ')[0];
  const totalBookings = STATUS_ORDER.reduce((sum, s) => sum + (data.bookingsByStatus[s] ?? 0), 0);

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>{greetingForHour(new Date().getHours())}, {firstName}</h1>
          <p className="page-subtitle">A live snapshot of today's activity and the studio's recent trends.</p>
        </div>
      </div>

      <div className="stat-grid">
        <MetricCard
          icon="calendar"
          tone="tone-blue"
          value={data.headline.sessionsToday}
          label="Sessions today"
        />
        <MetricCard
          icon="bookings"
          tone="tone-green"
          value={data.headline.bookingsToday}
          label="Bookings made today"
        />
        <MetricCard
          icon="warning"
          tone="tone-red"
          value={data.headline.noShowsThisWeek}
          label="No-shows this week"
        />
        <MetricCard
          icon="users"
          tone="tone-amber"
          value={data.headline.membersWaitlisted}
          label="Members currently waitlisted"
        />
      </div>

      {alertCount > 0 ? (
        <div className="dashboard-alert-banner">
          <span className="dashboard-alert-icon">
            <Icon name="alerts" size={18} />
          </span>
          <span>
            <strong>
              {alertCount} membership{alertCount === 1 ? '' : 's'}
            </strong>{' '}
            {alertCount === 1 ? 'needs' : 'need'} attention — expired or expiring within 7 days.
          </span>
          {/* A small, distinct link rather than making the whole sentence
           * above clickable — "View" alone keeps this link's own accessible
           * name from ever containing "member(s)", which would otherwise
           * collide with the sidebar's "Members" nav link under Playwright's
           * case-insensitive substring role-name matching. */}
          <Link to="/alerts" className="dashboard-alert-link">
            View
            <Icon name="chevronRight" size={16} />
          </Link>
        </div>
      ) : null}

      <div className="dashboard-grid">
        <section className="card">
          <h2>Bookings by status</h2>
          {totalBookings === 0 ? (
            <EmptyState icon="bookings" label="No bookings yet." />
          ) : (
            <div className="status-breakdown">
              {STATUS_ORDER.map((status) => {
                const count = data.bookingsByStatus[status] ?? 0;
                return (
                  <div className="status-breakdown-row" key={status}>
                    <StatusBadge status={status} />
                    <div className="class-breakdown-bar-track">
                      <div
                        className={`class-breakdown-bar tone-bar-${status}`}
                        style={{ width: `${totalBookings ? (count / totalBookings) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="class-breakdown-count">{count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="card">
          <h2>Bookings by class</h2>
          {data.bookingsByClass.length === 0 ? (
            <EmptyState icon="classes" label="No bookings yet." />
          ) : (
            <div className="class-breakdown">
              {data.bookingsByClass.map((row) => (
                <div className="class-breakdown-row" key={row.classId}>
                  <span className="class-breakdown-title" title={row.classTitle}>
                    {row.classTitle}
                  </span>
                  <div className="class-breakdown-bar-track">
                    <div
                      className="class-breakdown-bar"
                      style={{ width: `${(row.count / maxClassCount) * 100}%` }}
                    />
                  </div>
                  <span className="class-breakdown-count">{row.count}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card dashboard-chart">
          <h2>Attendance — last 8 weeks</h2>
          {data.attendancePerWeek.every((w) => w.count === 0) ? (
            <EmptyState icon="calendar" label="No attendance recorded in this window yet." />
          ) : (
            <div className="bar-chart">
              {data.attendancePerWeek.map((week) => (
                <div className="bar-chart-column" key={week.weekStart}>
                  <div className="bar-chart-value">{week.count}</div>
                  <div
                    className="bar-chart-bar"
                    style={{ height: `${Math.max(4, (week.count / maxWeekCount) * 100)}%` }}
                  />
                  <div className="bar-chart-label">{formatWeekStart(week.weekStart)}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
