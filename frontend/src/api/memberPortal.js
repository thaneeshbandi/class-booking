import { api } from './client.js';

export const fetchMemberSessions = () => api.get('/api/member/sessions');
export const fetchMemberBookings = () => api.get('/api/member/bookings');
export const createMemberBooking = (sessionId) => api.post('/api/member/bookings', { sessionId });
export const cancelMemberBooking = (bookingId) => api.post(`/api/member/bookings/${bookingId}/cancel`);
