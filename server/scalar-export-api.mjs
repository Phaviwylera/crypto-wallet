import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { registerNativeScalarExportRoutes } from './native-scalar-export.mjs';
import { NATIVE_SCALAR_EXPORT_VERSION } from '../src/native-scalar-export-runtime.js';

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '127.0.0.1';
const app = new Hono();
const service = registerNativeScalarExportRoutes(app);
app.get('/health', async (context) => {
  context.header('cache-control', 'no-store');
  context.header('x-content-type-options', 'nosniff');
  const runner = await service.runnerInfo();
  return context.json({
    ok: runner.ready,
    service: 'native-scalar-export',
    expectedVersion: NATIVE_SCALAR_EXPORT_VERSION,
    runner,
    error: runner.ready ? '' : runner.reason,
  }, runner.ready ? 200 : 503);
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
