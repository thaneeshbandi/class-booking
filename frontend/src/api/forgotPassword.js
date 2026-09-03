import { api } from './client.js';

export const requestPasswordReset = (email) => api.post('/api/auth/forgot-password/request', { email });
export const verifyPasswordResetOtp = (email, otp) =>
  api.post('/api/auth/forgot-password/verify', { email, otp });
export const resetPassword = (resetToken, newPassword, confirmNewPassword) =>
  api.post('/api/auth/forgot-password/reset', { resetToken, newPassword, confirmNewPassword });
