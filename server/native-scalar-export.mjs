import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSearchRange } from '../src/search-range.js';
import { parseScalarSampleCount } from '../src/scalar-wallet.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BINARY = path.join(PROJECT_ROOT, '.runtime', 'bin', 'seedlab-eth-export');
const DEFAULT_OUTPUT_ROOT = path.join(PROJECT_ROOT, '.runtime', 'scalar-exports');
const ROW_BYTES = 110n;
const RETENTION_MS = 30 * 60 * 1000;
const MAX_RETAINED_JOBS = 8;

function apiError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeThreads(value = 2) {
  const threads = Number(value);
  if (!Number.isInteger(threads) || threads < 1 || threads > 32) throw apiError('Threads must be an integer from 1 through 32.');
  return threads;
}

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    lower: job.lower,
    upper: job.upper,
    count: job.count,
    mode: job.mode,
    sampleCount: job.sampleCount,
    completed: job.completed,
    bytes: job.bytes,
    totalBytes: job.totalBytes,
    ratePerSecond: job.ratePerSecond,
    fileName: job.fileName,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    canStop: job.state === 'STARTING' || job.state === 'RUNNING' || job.state === 'STOPPING',
    canDownload: job.state === 'COMPLETED',
  };
}

export function createNativeScalarExportService({
  binary = process.env.SEEDLAB_ETH_EXPORT_BIN || DEFAULT_BINARY,
  outputRoot = process.env.NATIVE_SCALAR_EXPORT_ROOT || DEFAULT_OUTPUT_ROOT,
  retentionMs = RETENTION_MS,
} = {}) {
  const jobs = new Map();
  const children = new Map();
  let startLock = false;
  const resolvedBinary = path.resolve(binary);
  const resolvedOutputRoot = path.resolve(outputRoot);

  const touch = (job) => {
    job.updatedAt = new Date().toISOString();
    job.updatedAtMs = Date.now();
  };

  async function prune() {
    const now = Date.now();
    const expired = [...jobs.values()].filter((job) => !children.has(job.id) && now - job.updatedAtMs > retentionMs);
    const retained = [...jobs.values()]
      .filter((job) => !children.has(job.id) && !expired.includes(job))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    expired.push(...retained.slice(MAX_RETAINED_JOBS));
    await Promise.all([...new Set(expired)].map(async (job) => {
      jobs.delete(job.id);
      await Promise.all([rm(job.output, { force: true }), rm(job.partial, { force: true })]);
    }));

    // Job metadata is intentionally memory-only. A service restart therefore
    // invalidates old job IDs; remove their inaccessible files from this
    // dedicated directory instead of leaving sensitive orphans behind.
    let entries;
    try { entries = await readdir(resolvedOutputRoot, { withFileTypes: true }); } catch { return; }
    const known = new Set([...jobs.values()].flatMap((job) => [job.output, job.partial]));
    const orphans = entries
      .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.txt(?:\.partial)?$/.test(entry.name))
      .map((entry) => path.join(resolvedOutputRoot, entry.name))
      .filter((filename) => !known.has(filename));
    await Promise.all(orphans.map((filename) => rm(filename, { force: true })));
  }

  const cleanupTimer = setInterval(() => { prune().catch(() => {}); }, Math.min(retentionMs, 60000));
  cleanupTimer.unref();

  async function runnerInfo() {
    try {
      await access(resolvedBinary, fsConstants.X_OK);
      return { available: true, reason: '' };
    } catch {
      return { available: false, reason: 'Native Ethereum exporter is not installed on this service.' };
    }
  }

  async function start(body) {
    await prune();
    if (children.size || startLock) throw apiError('Another native scalar export is already running.', 409);
    startLock = true;
    try {
      return await startLocked(body);
    } finally {
      startLock = false;
    }
  }

  async function startLocked(body) {
    let range;
    try {
      range = parseSearchRange(String(body.lower ?? '').trim(), String(body.upper ?? '').trim());
    } catch (error) {
      throw apiError(error.message);
    }
    const threads = normalizeThreads(body.threads);
    const mode = body.mode === 'random' || body.sampleCount !== undefined ? 'random' : 'all';
    let sampleCount = null;
    if (mode === 'random') {
      try {
        sampleCount = parseScalarSampleCount(String(body.sampleCount ?? '').trim(), range.count);
      } catch (error) {
        throw apiError(error.message);
      }
      if (sampleCount > 0xffffffffffffffffn) throw apiError('Sample count is too large for the native exporter.');
    }
    const exportCount = sampleCount ?? range.count;
    const runner = await runnerInfo();
    if (!runner.available) throw apiError(runner.reason, 503);
    await mkdir(resolvedOutputRoot, { recursive: true, mode: 0o700 });

    const id = randomUUID();
    const lower = range.start.toString();
    const upper = range.end.toString();
    const output = path.join(resolvedOutputRoot, `${id}.txt`);
    const now = new Date().toISOString();
    const job = {
      id,
      lower,
      upper,
      count: exportCount.toString(),
      mode,
      sampleCount: sampleCount ? sampleCount.toString() : null,
      completed: '0',
      bytes: '0',
      totalBytes: (exportCount * ROW_BYTES).toString(),
      ratePerSecond: 0,
      fileName: mode === 'random'
        ? `address-private-keys-ethereum-${lower}-${upper}-random-${exportCount}.txt`
        : `address-private-keys-ethereum-${lower}-${upper}.txt`,
      state: 'STARTING',
      error: '',
      output,
      partial: `${output}.partial`,
      createdAt: now,
      updatedAt: now,
      updatedAtMs: Date.now(),
      stopRequested: false,
    };
    jobs.set(id, job);

    let child;
    try {
      const args = ['--start', lower, '--end', upper, '--threads', String(threads), '--output', output];
      if (sampleCount) args.push('--sample', sampleCount.toString());
      child = spawn(resolvedBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      job.state = 'ERROR';
      job.error = error.message;
      touch(job);
      throw error;
    }
    children.set(id, child);
    let stdout = '', stderr = '', settled = false;
    const append = (current, chunk) => `${current}${chunk}`.slice(-65536);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
      const matches = [...stderr.matchAll(/Generated (\d+) \/ \d+ rows/g)];
      if (matches.length) {
        job.completed = matches.at(-1)[1];
        touch(job);
      }
    });
    child.once('spawn', () => {
      if (job.state === 'STARTING') job.state = 'RUNNING';
      touch(job);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      children.delete(id);
      job.state = 'ERROR';
      job.error = error.message;
      touch(job);
    });
    child.once('close', async (code, signal) => {
      if (settled) return;
      settled = true;
      children.delete(id);
      if (code === 0) {
        try {
          const details = await stat(output);
          if (BigInt(details.size) !== exportCount * ROW_BYTES) throw new Error('Native exporter returned an incorrect output size.');
          job.state = 'COMPLETED';
          job.completed = job.count;
          job.bytes = String(details.size);
          job.ratePerSecond = Number(stdout.match(/Complete: \d+ rows, \d+ bytes, (\d+) rows\/s/)?.[1] || 0);
        } catch (error) {
          job.state = 'ERROR';
          job.error = error.message;
        }
      } else {
        job.state = job.stopRequested ? 'CANCELLED' : 'ERROR';
        job.error = job.stopRequested
          ? 'Generation cancelled; only an incomplete partial remains until cleanup.'
          : (stderr.trim().split('\n').at(-1) || `Native exporter exited with ${signal || `code ${code}`}.`).slice(-500);
      }
      touch(job);
    });
    return { ok: true, job: publicJob(job) };
  }

  async function status(id = '') {
    await prune();
    if (id) {
      const job = jobs.get(String(id));
      if (!job) throw apiError('Native scalar export job not found.', 404);
      return { job: publicJob(job) };
    }
    return { jobs: [...jobs.values()].map(publicJob), runner: await runnerInfo() };
  }

  async function stop(body) {
    const id = String(body.id || '');
    const job = jobs.get(id);
    const child = children.get(id);
    if (!job || !child) throw apiError('No active native scalar export was found for that job.', 409);
    job.stopRequested = true;
    job.state = 'STOPPING';
    touch(job);
    if (!child.kill('SIGTERM')) throw apiError('Could not signal the native exporter.', 500);
    return { ok: true, job: publicJob(job) };
  }

  async function remove(body) {
    const id = String(body.id || '');
    const job = jobs.get(id);
    if (!job) throw apiError('Native scalar export job not found.', 404);
    if (children.has(id)) throw apiError('Stop the active export before deleting it.', 409);
    await Promise.all([rm(job.output, { force: true }), rm(job.partial, { force: true })]);
    jobs.delete(id);
    return { ok: true };
  }

  async function download(id) {
    const job = jobs.get(String(id));
    if (!job || job.state !== 'COMPLETED') throw apiError('Completed native scalar export not found.', 404);
    let details;
    try { details = await stat(job.output); } catch { throw apiError('The exported file is no longer available.', 404); }
    if (BigInt(details.size) !== BigInt(job.totalBytes)) throw apiError('The exported file size is invalid.', 500);
    return { stream: createReadStream(job.output), size: details.size, fileName: job.fileName };
  }

  function shutdown() {
    clearInterval(cleanupTimer);
    for (const child of children.values()) child.kill('SIGTERM');
  }

  return { start, status, stop, remove, download, runnerInfo, shutdown, jobs, outputRoot: resolvedOutputRoot };
}

async function jsonBody(context) {
  try {
    const body = await context.req.json();
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('not an object');
    return body;
  } catch {
    throw apiError('Request body must be a JSON object.');
  }
}

function authorized(context) {
  const expected = process.env.NATIVE_PUZZLE_API_TOKEN || '';
  if (!expected) return true;
  const authorization = context.req.header('authorization') || '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

function jsonRoute(handler, successStatus = 200) {
  return async (context) => {
    context.header('cache-control', 'private, no-store');
    context.header('x-content-type-options', 'nosniff');
    if (!authorized(context)) return context.json({ error: 'A valid native API bearer token is required for scalar export.' }, 401);
    try {
      return context.json(await handler(context), successStatus);
    } catch (error) {
      const status = error.statusCode || 500;
      return context.json({ error: status < 500 ? error.message : 'Native scalar export failed.' }, status);
    }
  };
}

export function registerNativeScalarExportRoutes(app, options = {}) {
  const service = createNativeScalarExportService(options);
  app.post('/api/native-scalar-export/start', jsonRoute(async (context) => service.start(await jsonBody(context)), 202));
  app.get('/api/native-scalar-export/status', jsonRoute((context) => service.status(context.req.query('id') || '')));
  app.post('/api/native-scalar-export/stop', jsonRoute(async (context) => service.stop(await jsonBody(context)), 202));
  app.post('/api/native-scalar-export/delete', jsonRoute(async (context) => service.remove(await jsonBody(context))));
  app.get('/api/native-scalar-export/download', async (context) => {
    context.header('cache-control', 'private, no-store');
    context.header('x-content-type-options', 'nosniff');
    context.header('referrer-policy', 'no-referrer');
    if (!authorized(context)) return context.json({ error: 'A valid native API bearer token is required for scalar export.' }, 401);
    try {
      const result = await service.download(context.req.query('id') || '');
      context.header('content-type', 'text/plain; charset=utf-8');
      context.header('content-length', String(result.size));
      context.header('content-disposition', `attachment; filename="${result.fileName}"`);
      return context.body(Readable.toWeb(result.stream));
    } catch (error) {
      const status = error.statusCode || 500;
      return context.json({ error: status < 500 ? error.message : 'Native scalar download failed.' }, status);
    }
  });
  return service;
}
