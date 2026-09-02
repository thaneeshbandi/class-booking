import { api } from './client.js';

export const login = (email, password) => api.post('/api/auth/login', { email, password });
export const logout = () => api.post('/api/auth/logout');
export const fetchCurrentUser = () => api.get('/api/auth/me');
