import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/AppShell.jsx';
import { RequireAuth, RequireStaff } from './components/RouteGuards.jsx';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { AlertsPage } from './pages/AlertsPage.jsx';
import { BookingDetailPage } from './pages/BookingDetailPage.jsx';
import { BookingsPage } from './pages/BookingsPage.jsx';
import { ClassesPage } from './pages/ClassesPage.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { MembersPage } from './pages/MembersPage.jsx';
import { RecurringSessionsPage } from './pages/RecurringSessionsPage.jsx';
import { SessionDetailPage } from './pages/SessionDetailPage.jsx';
import { SessionsPage } from './pages/SessionsPage.jsx';
import { SignupPage } from './pages/SignupPage.jsx';
import { WelcomePage } from './pages/WelcomePage.jsx';

/** Staff land on the studio-wide dashboard; instructors have no access to
 * it (goal 8 is staff-only), so they land on their own session list. A
 * signed-up `member` account lands on its own welcome page — not Sessions
 * or Bookings, which are scoped to instructor ownership and would render
 * empty and confusing for a role that owns no sessions at all. */
function HomeRedirect() {
  const { isStaff, isMember } = useAuth();
  return <Navigate to={isStaff ? '/dashboard' : isMember ? '/welcome' : '/sessions'} replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<HomeRedirect />} />

          <Route element={<RequireStaff />}>
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="members" element={<MembersPage />} />
            <Route path="alerts" element={<AlertsPage />} />
            <Route path="classes" element={<ClassesPage />} />
            <Route path="sessions/recurring" element={<RecurringSessionsPage />} />
          </Route>

          <Route path="welcome" element={<WelcomePage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="sessions/:id" element={<SessionDetailPage />} />
          <Route path="bookings" element={<BookingsPage />} />
          <Route path="bookings/:id" element={<BookingDetailPage />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
