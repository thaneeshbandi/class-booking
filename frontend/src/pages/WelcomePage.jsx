import { useAuth } from '../context/AuthContext.jsx';

/**
 * Landing page for a signed-up `member` account. Deliberately not the
 * staff/instructor Sessions or Bookings views: those are scoped to "sessions
 * you're the instructor for," which a member is never the primary or a
 * co-instructor of, so they'd render as a confusingly-empty admin screen
 * rather than anything a member could actually use. Self-service booking is
 * a listed stretch idea, not a mandatory goal, and hasn't been built — this
 * page says that plainly instead of pretending otherwise.
 */
export function WelcomePage() {
  const { user } = useAuth();

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Welcome, {user.fullName}</h1>
          <p className="page-subtitle">Your account is set up and signed in.</p>
        </div>
      </div>

      <div className="card">
        <p className="muted">
          Self-service booking isn't available yet — for now, a studio staff member can book you into
          a class. Check back here once that's ready.
        </p>
      </div>
    </div>
  );
}
