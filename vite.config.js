import { defineConfig } from 'vite';
import { getStatusSnapshot } from './scripts/puzzle-status-server.mjs';
import { nativePuzzleApi } from './scripts/native-puzzle-api.mjs';

function puzzleCampaignApi() {
  const middleware = async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('allow', 'GET, HEAD');
      response.end('Method not allowed.');
      return;
    }
    try {
      const body = JSON.stringify(await getStatusSnapshot());
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.setHeader('x-content-type-options', 'nosniff');
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Unable to read campaign status.' }));
    }
  };

  return {
    name: 'puzzle-campaign-api',
    configureServer(server) {
      server.middlewares.use('/api/puzzle-campaigns', middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/puzzle-campaigns', middleware);
    },
  };
}

export default defineConfig({
  plugins: [puzzleCampaignApi(), nativePuzzleApi()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      // Dev: forward other API calls to the local scan server (npm run server).
      '/api': {
        target: process.env.SCAN_SERVER_URL || 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
