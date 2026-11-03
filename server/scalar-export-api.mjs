import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { registerNativeScalarExportRoutes } from './native-scalar-export.mjs';

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '127.0.0.1';
const app = new Hono();
const service = registerNativeScalarExportRoutes(app);
app.get('/health', (context) => {
  context.header('cache-control', 'no-store');
  return context.json({ ok: true, service: 'native-scalar-export' });
});

const httpServer = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`Seedlab native scalar export API listening on http://${HOST}:${info.port}`);
});
httpServer.once('close', service.shutdown);
const shutdown = () => {
  service.shutdown();
  httpServer.close(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
