// HTTP API for server-side wallet scanning.
// Local mode: accepts a multipart file upload, runs the scan in-process, and
// returns results via polling. AWS mode: returns a presigned S3 PUT URL, then an
// S3 upload event triggers the scan (see lambda.js).
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseWalletFile } from './lib/parse.mjs';
import { runScan } from './lib/scan.mjs';
import { createStore } from './lib/store.mjs';
import { listUploadsBucket } from './lib/s3.mjs';

const MODE = process.env.STORE_MODE || 'memory';
const PORT = Number(process.env.PORT || 8787);
const DIST = new URL('../dist/', import.meta.url);

export function createApp() {
  const app = new Hono();
  const store = createStore(MODE);

  app.get('/health', (c) => c.json({ ok: true, mode: MODE }));

  // Start a scan job. In memory mode this reads the uploaded file directly.
  app.post('/api/scan', async (c) => {
    const jobId = randomUUID();

    if (MODE === 'aws' || MODE === 'dynamo') {
      // Hand off the file to S3; an S3 event will trigger processing.
      const { uploadUrl, key } = await listUploadsBucket().createPresignedUploadUrl(jobId);
      await store.createJob(jobId, 0);
      await store.updateJob(jobId, { status: 'waiting_upload', uploadKey: key });
      return c.json({ jobId, uploadUrl, mode: 'aws' });
    }

    // Local/dev: read the multipart file from the request body.
    let fileBuffer;
    let filename = 'upload.txt';
    const contentType = c.req.header('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody({ all: true });
      const file = body.file;
      if (!file) return c.json({ error: 'No file field named "file" in the upload.' }, 400);
      filename = file.name || filename;
      fileBuffer = Buffer.from(await file.arrayBuffer());
    } else {
      fileBuffer = Buffer.from(await c.req.arrayBuffer());
    }

    let lines;
    try {
      lines = parseWalletFile(filename, fileBuffer);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }

    // Kick off scan asynchronously; the request returns immediately.
    runScan(jobId, lines, store).catch((err) => console.error('scan failed', jobId, err));
    return c.json({ jobId, total: lines.length, mode: 'memory' });
  });

  // Poll job status + (partial) results.
  app.get('/api/scan/:jobId', async (c) => {
    const job = await store.getJob(c.req.param('jobId'));
    if (!job) return c.json({ error: 'Job not found' }, 404);
    return c.json(job);
  });

  // In production (local/EC2), serve the built static site from dist/.
  if (MODE !== 'aws') {
    app.get('*', async (c) => {
      if (!existsSync(DIST)) {
        return c.json({ error: 'Static build not found. Run `npm run build` first.' }, 404);
      }
      const url = new URL(c.req.url);
      let path = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = fileURLToPath(new URL(`.${path}`, DIST));
      try {
        const data = await readFile(filePath);
        const ext = path.split('.').pop();
        const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml' };
        return c.body(data, 200, { 'content-type': types[ext] || 'application/octet-stream' });
      } catch {
        // SPA fallback to index.html for client-side routes.
        const data = await readFile(fileURLToPath(new URL('./index.html', DIST)));
        return c.body(data, 200, { 'content-type': 'text/html' });
      }
    });
  }

  return app;
}

// Node entry point (local dev / EC2 process).
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
    console.log(`Seedlab scan API listening on http://localhost:${info.port} (mode=${MODE})`);
  });
}
