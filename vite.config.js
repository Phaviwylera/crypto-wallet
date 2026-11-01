import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      // Dev: forward API calls to the local scan server (npm run server).
      '/api': {
        target: process.env.SCAN_SERVER_URL || 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
