import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '../context/AuthContext.jsx';
import { LoadingState } from './States.jsx';

/**
 * Route guards are a UX convenience, full stop — every page behind them
 * still makes its own requests, and the backend independently authorizes
 * every one of those. A guard only decides what to *render*; it never
 * decides what is *allowed*, and removing it entirely would change nothing
 * about what data an unauthorized user could actually get, since the
 * server-side checks are what actually enforce anything.
 */

export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingState label="Checking your session…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <Outlet />;
}

export function RequireStaff() {
  const { isStaff } = useAuth();
  if (!isStaff) return <Navigate to="/sessions" replace />;
  return <Outlet />;
}
