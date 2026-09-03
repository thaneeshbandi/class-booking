import { Icon } from './Icon.jsx';

// Deliberately role-neutral — this panel is shared with the signup page,
// which must never suggest a privileged capability is one form submission
// away.
const CAPABILITIES = [
  { icon: 'sessions', text: 'Schedule classes and sessions across every room' },
  { icon: 'bookings', text: 'Track bookings, waitlists, and attendance in real time' },
  { icon: 'alerts', text: 'Catch expiring memberships before they lapse' },
];

/**
 * The shared split-screen shell for `/login` and `/signup` — a dark
 * branding panel (only, never a marketing claim beyond what the product
 * literally does) and a plain white panel for the form itself. Both pages
 * render through this so they can never visually drift apart.
 */
export function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="auth-screen">
      <div className="auth-brand-panel">
        <div className="auth-brand-panel-inner">
          <div className="auth-brand">
            <span className="auth-brand-mark" aria-hidden="true">
              <Icon name="calendar" size={20} />
            </span>
            <span className="auth-brand-name">Class Booking</span>
          </div>
          <p className="auth-brand-statement">
            The studio's operating system for classes, sessions, and bookings — schedule, book, and
            track it all in one place.
          </p>
          <ul className="auth-capability-list">
            {CAPABILITIES.map((item) => (
              <li key={item.icon}>
                <span className="auth-capability-icon" aria-hidden="true">
                  <Icon name={item.icon} size={16} />
                </span>
                {item.text}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="auth-form-panel">
        <div className="auth-form-panel-inner">
          <div className="auth-brand auth-brand-mobile">
            <span className="auth-brand-mark" aria-hidden="true">
              <Icon name="calendar" size={18} />
            </span>
            <span className="auth-brand-name">Class Booking</span>
          </div>
          <h1>{title}</h1>
          <p className="auth-subtitle">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}
