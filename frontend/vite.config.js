import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local dev only needs the default port (5173); the backend's
// FRONTEND_ORIGIN default already matches it. No dev-server proxy is used —
// the API client always calls the backend's own absolute URL
// (VITE_API_BASE_URL), and CORS on the backend is what makes that work
// cross-origin with credentials.
export default defineConfig({
  plugins: [react()],
});
