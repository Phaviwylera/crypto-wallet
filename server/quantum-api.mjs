// Optional local API for the educational N=15 Shor lab.
// Fixed modulus, fixed circuit, no wallet inputs, no shell, one simulation at a time.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts/shors_algorithm.py');
const BASES = new Set([2, 4, 7, 8, 11, 13]);
const PORT = Number(process.env.QUANTUM_PORT || 8789);
const HOST = process.env.QUANTUM_HOST || '127.0.0.1';

export function quantumPythonPath() {
  if (process.env.QUANTUM_PYTHON) return process.env.QUANTUM_PYTHON;
  const venv = path.join(ROOT, '.runtime/quantum-venv/bin/python');
  return existsSync(venv) ? venv : 'python3';
}

function runProcess(command, args, { timeout = 30000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error('Quantum simulation timed out.')); }
    }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBytes && !settled) { settled = true; child.kill('SIGKILL'); clearTimeout(timer); reject(new Error('Simulation output exceeded the safety limit.')); }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function probeQuantum(python = quantumPythonPath()) {
  try {
    const { code, stdout } = await runProcess(python, ['-c', 'import json,qiskit,qiskit_aer; print(json.dumps({"qiskit":qiskit.__version__,"aer":qiskit_aer.__version__}))'], { timeout: 8000, maxBytes: 4096 });
    if (code !== 0) return { available: false, ready: false, reason: 'Qiskit/Aer is not installed. Run: bash scripts/setup-shors-lab.sh' };
    const versions = JSON.parse(stdout.trim());
    return { available: true, ready: true, python, ...versions, reason: '' };
  } catch {
    return { available: false, ready: false, reason: 'Qiskit/Aer is not installed. Run: bash scripts/setup-shors-lab.sh' };
  }
}

export function validateShorRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object.');
  const N = body.N ?? 15;
  if (N !== 15) throw new Error('Only N=15 is supported by this educational circuit.');
  const base = body.base ?? null;
  if (base !== null && (!Number.isInteger(base) || !BASES.has(base))) throw new Error('base must be null or one of 2, 4, 7, 8, 11, 13.');
  const shots = body.shots ?? 1;
  if (!Number.isInteger(shots) || shots < 1 || shots > 1024) throw new Error('shots must be 1 through 1024.');
  const maxAttempts = body.maxAttempts ?? 10;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('maxAttempts must be 1 through 10.');
  const seed = body.seed ?? null;
  if (seed !== null && (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF)) throw new Error('seed must be null or 0 through 4294967295.');
  return { base, shots, maxAttempts, seed };
}

export async function runShorExperiment(options, python = quantumPythonPath()) {
  const args = [SCRIPT, '--json', '--shots', String(options.shots), '--max-attempts', String(options.maxAttempts)];
  if (options.base !== null) args.push('--base', String(options.base));
  if (options.seed !== null) args.push('--seed', String(options.seed));
  const { code, stdout, stderr } = await runProcess(python, args, { timeout: 60000 });
  let result;
  try { result = JSON.parse(stdout.trim()); } catch { throw new Error(stderr.trim() || `Simulator exited with code ${code} without JSON.`); }
  if (result.ok === false) throw new Error(result.error || 'Simulator rejected the request.');
  if (code !== 0 && !result.success) throw new Error(result.error || 'No factors found within the attempt limit.');
  return result;
}

export function createQuantumApp({ probe = probeQuantum, run = runShorExperiment } = {}) {
  const app = new Hono();
  let busy = false;
  app.get('/api/quantum/health', async (c) => {
    const runner = await probe();
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
    return c.json({ ok: runner.ready, service: 'shor-n15', N: 15, hardware: false, runner }, runner.ready ? 200 : 503);
  });
  app.post('/api/quantum/shor', async (c) => {
    if (Number(c.req.header('content-length') || 0) > 4096) return c.json({ error: 'Request too large.' }, 413);
    let options;
    try {
      const text = await c.req.text();
      if (text.length > 4096) return c.json({ error: 'Request too large.' }, 413);
      options = validateShorRequest(text ? JSON.parse(text) : {});
    } catch (error) {
      return c.json({ error: error.message || 'Invalid JSON.' }, 400);
    }
    const runner = await probe();
    if (!runner.ready) return c.json({ error: runner.reason }, 503);
    if (busy) return c.json({ error: 'A simulation is already running. Try again shortly.' }, 409);
    busy = true;
    try {
      const result = await run(options);
      c.header('cache-control', 'no-store');
      return c.json(result);
    } catch (error) {
      return c.json({ error: error.message || 'Simulation failed.' }, 500);
    } finally {
      busy = false;
    }
  });
  return app;
}

export function registerQuantumRoutes(app) {
  const quantum = createQuantumApp();
  app.get('/api/quantum/health', (c) => quantum.fetch(c.req.raw));
  app.post('/api/quantum/shor', (c) => quantum.fetch(c.req.raw));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createQuantumApp();
  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`Seedlab Shor N=15 simulator API listening on http://${HOST}:${info.port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
