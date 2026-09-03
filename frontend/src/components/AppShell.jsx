import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '../context/AuthContext.jsx';
import { useAlertCount } from '../hooks/useAlertCount.js';
import { Avatar } from './Avatar.jsx';
import { Icon } from './Icon.jsx';

/**
 * Role-aware navigation. This is a UX convenience only — every link here
 * leads to a page whose own data requests are independently authorized by
 * the backend, so hiding a link never substitutes for that. An instructor
 * who guessed a staff-only URL would still get the exact same 403 the
 * backend already returns for that request; nothing client-side treats
 * `role` as authoritative.
 */
const STAFF_LINKS = [
  { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { to: '/members', label: 'Members', icon: 'members' },
  { to: '/alerts', label: 'Alerts', icon: 'alerts' },
  { to: '/classes', label: 'Classes', icon: 'classes' },
  { to: '/sessions', label: 'Sessions', icon: 'sessions' },
  { to: '/bookings', label: 'Bookings', icon: 'bookings' },
  { to: '/profile', label: 'Profile', icon: 'users' },
];

const INSTRUCTOR_LINKS = [
  { to: '/sessions', label: 'My Sessions', icon: 'sessions' },
  { to: '/bookings', label: 'Bookings', icon: 'bookings' },
  { to: '/profile', label: 'Profile', icon: 'users' },
];

// A `member` account's own portal: browse sessions, its own bookings, and
// its profile — never a staff/instructor view. The backend enforces this
// boundary independently on every request (see `routes/memberBookings.js`);
// this list is a navigation convenience only.
const MEMBER_LINKS = [
  { to: '/member', label: 'Home', icon: 'home', end: true },
  { to: '/member/sessions', label: 'Sessions', icon: 'sessions' },
  { to: '/member/bookings', label: 'My Bookings', icon: 'bookings' },
  { to: '/profile', label: 'Profile', icon: 'users' },
];

/** A short, human page label for the topbar's context slot — matched by
 * longest prefix so `/sessions/123` still reads as "Sessions". Purely a
 * display convenience; it never drives routing or authorization. */
const PAGE_LABELS = [
  ['/dashboard', 'Dashboard'],
  ['/members', 'Members'],
  ['/alerts', 'Alerts'],
  ['/classes', 'Classes'],
  ['/sessions/recurring', 'Generate recurring sessions'],
  ['/sessions', 'Sessions'],
  ['/bookings', 'Bookings'],
  ['/profile', 'Profile'],
  ['/member/sessions', 'Sessions'],
  ['/member/bookings', 'My Bookings'],
  ['/member', 'Home'],
];

function pageLabelFor(pathname) {
  const match = PAGE_LABELS.filter(([prefix]) => pathname.startsWith(prefix)).sort(
    (a, b) => b[0].length - a[0].length,
  )[0];
  return match?.[1] ?? '';
}

function NavLinks({ links, alertCount, onNavigate }) {
  return (
    <nav className="sidebar-nav">
      {links.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.end}
          onClick={onNavigate}
          className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
        >
          <Icon name={link.icon} size={18} />
          <span className="sidebar-link-label">{link.label}</span>
          {link.to === '/alerts' && alertCount > 0 ? (
            <span className="nav-badge">{alertCount}</span>
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}

export function AppShell() {
  const { user, logout, isStaff, isMember } = useAuth();
  const alertCount = useAlertCount();
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const links = isStaff ? STAFF_LINKS : isMember ? MEMBER_LINKS : INSTRUCTOR_LINKS;

  // Never leave the drawer open across a navigation or a viewport resize
  // back to desktop.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  return (
    <div className={`app-shell${mobileNavOpen ? ' mobile-nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark" aria-hidden="true">
            <Icon name="calendar" size={18} />
          </span>
          Class Booking
        </div>
        <NavLinks links={links} alertCount={alertCount} onNavigate={() => setMobileNavOpen(false)} />
        <div className="sidebar-footer">
          <Avatar fullName={user.fullName} size={30} />
          <div className="sidebar-footer-text">
            <div className="sidebar-footer-name">{user.fullName}</div>
          </div>
        </div>
      </aside>

      {mobileNavOpen ? (
        <button
          type="button"
          className="mobile-nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="mobile-nav-toggle"
              aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen((open) => !open)}
            >
              <Icon name={mobileNavOpen ? 'close' : 'menu'} size={20} />
            </button>
            <span className="topbar-page-label">{pageLabelFor(location.pathname)}</span>
          </div>
          <div className="topbar-user">
            <Avatar fullName={user.fullName} size={30} />
            <div className="topbar-user-text">
              <span className="user-name">{user.fullName}</span>
              <span className="badge tone-gray">{user.role}</span>
            </div>
            <button type="button" className="btn btn-secondary btn-small" onClick={logout}>
              <Icon name="logout" size={15} />
              Log out
            </button>
          </div>
        </header>
        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
