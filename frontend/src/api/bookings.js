import { api } from './client.js';

/** `query` may include: q, classId, sessionId, status, sort, direction,
 * page, pageSize — the exact `GET /api/bookings` contract; passed straight
 * through, undefined/empty values are dropped by the client. */
export const fetchBookings = (query) => api.get('/api/bookings', query);
export const fetchBooking = (id) => api.get(`/api/bookings/${id}`);
export const createBooking = (sessionId, memberId) =>
  api.post('/api/bookings', { sessionId, memberId });
export const cancelBooking = (id, note) => api.post(`/api/bookings/${id}/cancel`, note ? { note } : undefined);
export const settleBooking = (id, status, note) =>
  api.post(`/api/bookings/${id}/settle`, { status, ...(note ? { note } : {}) });
