import { api, downloadResponse } from './client.js';

export const fetchSessions = (query) => api.get('/api/sessions', query);
export const fetchSession = (id) => api.get(`/api/sessions/${id}`);
export const createSession = (body) => api.post('/api/sessions', body);
export const updateSession = (id, body) => api.patch(`/api/sessions/${id}`, body);
export const deleteSession = (id) => api.del(`/api/sessions/${id}`);
export const generateRecurringSessions = (body) => api.post('/api/sessions/recurring', body);

export const fetchSessionBookings = (sessionId) => api.get(`/api/sessions/${sessionId}/bookings`);

export const fetchCoInstructors = (sessionId) => api.get(`/api/sessions/${sessionId}/co-instructors`);
export const addCoInstructor = (sessionId, instructorId) =>
  api.post(`/api/sessions/${sessionId}/co-instructors`, { instructorId });
export const removeCoInstructor = (sessionId, instructorId) =>
  api.del(`/api/sessions/${sessionId}/co-instructors/${instructorId}`);

/** Fetches and triggers a browser download for the session's attendance
 * CSV — the backend generates the file; nothing here recreates it. */
export async function downloadAttendanceCsv(sessionId) {
  const response = await api.getRaw(`/api/sessions/${sessionId}/attendance.csv`);
  await downloadResponse(response, `attendance-session-${sessionId}.csv`);
}
