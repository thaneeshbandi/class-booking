import { NavLink, Outlet } from 'react-router-dom';

import { useAuth } from '../context/AuthContext.jsx';
import { useAlertCount } from '../hooks/useAlertCount.js';

/**
 * Role-aware navigation. This is a UX convenience only — every link here
 * leads to a page whose own data requests are independently authorized by
 * the backend, so hiding a link never substitutes for that. An instructor
 * who guessed a staff-only URL would still get the exact same 403 the
 * backend already returns for that request; nothing client-side treats
 * `role` as authoritative.
 */
const STAFF_LINKS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/members', label: 'Members' },
  { to: '/alerts', label: 'Alerts' },
  { to: '/classes', label: 'Classes' },
  { to: '/sessions', label: 'Sessions' },
  { to: '/bookings', label: 'Bookings' },
];

const INSTRUCTOR_LINKS = [
  { to: '/sessions', label: 'My Sessions' },
  { to: '/bookings', label: 'Bookings' },
];

// A signed-up `member` account has no elevated access anywhere in the API
// (see migration 011) and no self-service feature has been built yet, so
// there is nothing to link to beyond its own welcome page — an honest
// reflection of what the account can actually do, not a placeholder for
// admin views it would only see empty.
const MEMBER_LINKS = [{ to: '/welcome', label: 'Home' }];

export function AppShell() {
  const { user, logout, isStaff, isMember } = useAuth();
  const alertCount = useAlertCount();
  const links = isStaff ? STAFF_LINKS : isMember ? MEMBER_LINKS : INSTRUCTOR_LINKS;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">Class Booking</div>
        <nav className="sidebar-nav">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            >
              {link.label}
              {link.to === '/alerts' && alertCount > 0 ? (
                <span className="nav-badge">{alertCount}</span>
              ) : null}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="topbar-user">
            <span className="user-name">{user.fullName}</span>
            <span className="badge tone-gray">{user.role}</span>
          </div>
          <button type="button" className="btn btn-secondary btn-small" onClick={logout}>
            Log out
          </button>
        </header>
        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
