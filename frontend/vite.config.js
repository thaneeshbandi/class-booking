import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `/api` is proxied to the backend on :3000, mirroring `vercel.json`'s
// production rewrite: the browser only ever talks to :5173, same-origin,
// so the auth cookie behaves identically in dev and in production (plain
// `SameSite=Lax`, no cross-site cookie handling to reason about in either
// place). `src/api/client.js` defaults to the page's own origin for exactly
// this reason. `changeOrigin` rewrites the proxied request's `Host` header
// to match the target, which the backend doesn't currently depend on but is
// the standard, safe default for this kind of proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
