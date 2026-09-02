import { api } from './client.js';

export const fetchClasses = (includeArchived = false) =>
  api.get('/api/classes', includeArchived ? { includeArchived: 'true' } : undefined);
export const fetchClass = (id) => api.get(`/api/classes/${id}`);
export const createClass = (body) => api.post('/api/classes', body);
export const updateClass = (id, body) => api.patch(`/api/classes/${id}`, body);
export const archiveClass = (id) => api.post(`/api/classes/${id}/archive`);
export const restoreClass = (id) => api.post(`/api/classes/${id}/restore`);
