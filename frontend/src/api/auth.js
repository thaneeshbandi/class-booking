import { api } from './client.js';

export const login = (email, password) => api.post('/api/auth/login', { email, password });
// No `role` field — the backend hardcodes every signup to the unprivileged
// `member` role server-side; there is no request shape that could ask for
// anything else (see `docs/decisions.md`).
export const signup = (fullName, email, password) =>
  api.post('/api/auth/signup', { fullName, email, password });
export const logout = () => api.post('/api/auth/logout');
export const fetchCurrentUser = () => api.get('/api/auth/me');
