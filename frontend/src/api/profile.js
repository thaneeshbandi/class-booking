import { api } from './client.js';

export const fetchProfile = () => api.get('/api/profile');
export const updateProfile = (fullName) => api.patch('/api/profile', { fullName });
export const changePassword = (currentPassword, newPassword, confirmNewPassword) =>
  api.post('/api/profile/change-password', { currentPassword, newPassword, confirmNewPassword });
