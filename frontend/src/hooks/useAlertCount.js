import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { fetchExpiringAlerts } from '../api/members.js';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * The nav sidebar's alert badge count. Refetches on every route change
 * rather than holding its own mutation-aware cache — simple and predictable
 * (per the frontend brief's own "no complicated client cache" instruction):
 * navigating away from the Alerts page after a dismissal is exactly the
 * moment the badge should catch up, and a route change is what already
 * happens then.
 */
export function useAlertCount() {
  const { isStaff } = useAuth();
  const location = useLocation();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!isStaff) return;
    let cancelled = false;
    fetchExpiringAlerts()
      .then((data) => {
        if (!cancelled) setCount(data.alerts.length);
      })
      .catch(() => {
        // A transient failure here shouldn't break navigation — the Alerts
        // page itself surfaces the real error when the user opens it.
      });
    return () => {
      cancelled = true;
    };
  }, [isStaff, location.pathname]);

  return count;
}
