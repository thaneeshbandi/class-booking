import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { fetchCurrentUser, login as apiLogin, logout as apiLogout } from '../api/auth.js';
import { setUnauthorizedHandler } from '../api/client.js';

/**
 * The only place session/current-user state lives. `user` is `null` until
 * proven otherwise by the server — never assumed from a stored value, since
 * nothing about identity or role is ever kept client-side except what
 * `GET /api/auth/me` just returned. `loading` covers the one moment on
 * first load where "is there a valid session cookie already?" hasn't been
 * answered yet; every route guard waits for it before deciding anything.
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchCurrentUser()
      .then((data) => {
        if (!cancelled) setUser(data.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Any request anywhere in the app can discover mid-session that the
    // cookie no longer works (expired token, deactivated account) — this is
    // what turns that into "you are logged out" rather than a page-specific
    // error each caller has to handle separately.
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      isStaff: user?.role === 'staff',
      isInstructor: user?.role === 'instructor',
      async login(email, password) {
        const data = await apiLogin(email, password);
        setUser(data.user);
        return data.user;
      },
      async logout() {
        try {
          await apiLogout();
        } finally {
          setUser(null);
        }
      },
    }),
    [user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
