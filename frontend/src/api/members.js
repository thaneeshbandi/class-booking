import { api } from './client.js';

export const fetchMembers = () => api.get('/api/members');
export const createMember = (body) => api.post('/api/members', body);
export const updateMember = (id, body) => api.patch(`/api/members/${id}`, body);
export const fetchExpiringAlerts = () => api.get('/api/members/alerts/expiring');
export const dismissMembershipAlert = (memberId) =>
  api.post(`/api/members/${memberId}/alerts/membership-expiry/dismiss`);
