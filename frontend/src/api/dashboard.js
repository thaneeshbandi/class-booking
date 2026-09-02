import { api } from './client.js';

export const fetchDashboard = () => api.get('/api/dashboard');
