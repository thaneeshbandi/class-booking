import { api } from './client.js';

export const fetchInstructors = () => api.get('/api/users', { role: 'instructor' });
export const fetchStaffAndInstructors = () => api.get('/api/users');
export const createUser = (body) => api.post('/api/users', body);
