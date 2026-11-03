import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // In development, the Spring Boot server runs on :8080 (see CLAUDE.md).
    // xfwd passes the real client IP (X-Forwarded-For) like Caddy does, so rate limits apply per device.
    proxy: {
      '/api': { target: 'http://localhost:8080', xfwd: true },
      '/ws': { target: 'ws://localhost:8080', ws: true, xfwd: true },
    },
  },
})
