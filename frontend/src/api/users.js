import { api } from './client.js';

export const fetchInstructors = () => api.get('/api/users', { role: 'instructor' });
