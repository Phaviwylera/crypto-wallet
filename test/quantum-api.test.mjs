import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateShorRequest, createQuantumApp } from '../server/quantum-api.mjs';

const readyProbe = async () => ({ available: true, ready: true, qiskit: 'test', aer: 'test', reason: '' });
const missingProbe = async () => ({ available: false, ready: false, reason: 'Run setup' });

test('request validation enforces fixed N=15 and bounded simulator options', () => {
  assert.deepEqual(validateShorRequest({}), { base: null, shots: 1, maxAttempts: 10, seed: null });
  assert.deepEqual(validateShorRequest({ N: 15, base: 7, shots: 128, maxAttempts: 5, seed: 42 }), { base: 7, shots: 128, maxAttempts: 5, seed: 42 });
  for (const body of [{ N: 21 }, { base: 3 }, { base: '7' }, { shots: 0 }, { shots: 1025 }, { maxAttempts: 0 }, { maxAttempts: 11 }, { seed: -1 }, { seed: 2 ** 32 }, { seed: 1.5 }, []]) {
    assert.throws(() => validateShorRequest(body), Error);
  }
});

test('health reports ready and unavailable simulators without pretending hardware', async () => {
  const ready = createQuantumApp({ probe: readyProbe, run: async () => ({}) });
  const response = await ready.request('/api/quantum/health');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.hardware, false);
  assert.equal(body.N, 15);
  const missing = createQuantumApp({ probe: missingProbe, run: async () => ({}) });
  const missingResponse = await missing.request('/api/quantum/health');
  assert.equal(missingResponse.status, 503);
  assert.equal((await missingResponse.json()).ok, false);
});

test('POST runs only validated fixed-N requests and returns simulator JSON', async () => {
  let captured;
  const app = createQuantumApp({ probe: readyProbe, run: async (options) => { captured = options; return { success: true, factors: [3, 5], backend: 'qiskit-aer', hardware: false }; } });
  const response = await app.request('/api/quantum/shor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ N: 15, base: 7, shots: 8, seed: 42 }) });
  assert.equal(response.status, 200);
  assert.deepEqual(captured, { base: 7, shots: 8, maxAttempts: 10, seed: 42 });
  assert.deepEqual((await response.json()).factors, [3, 5]);
});

test('POST rejects invalid input, missing simulator and oversized bodies', async () => {
  const app = createQuantumApp({ probe: readyProbe, run: async () => ({}) });
  const invalid = await app.request('/api/quantum/shor', { method: 'POST', body: JSON.stringify({ N: 35 }) });
  assert.equal(invalid.status, 400);
  const missing = createQuantumApp({ probe: missingProbe, run: async () => ({}) });
  const unavailable = await missing.request('/api/quantum/shor', { method: 'POST', body: '{}' });
  assert.equal(unavailable.status, 503);
  const large = await app.request('/api/quantum/shor', { method: 'POST', body: 'x'.repeat(5000) });
  assert.equal(large.status, 413);
});

test('API permits one simulation at a time', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = createQuantumApp({ probe: readyProbe, run: async () => { await gate; return { success: true }; } });
  const first = app.request('/api/quantum/shor', { method: 'POST', body: '{}' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await app.request('/api/quantum/shor', { method: 'POST', body: '{}' });
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
});

test('quantum page is additive and existing lab/auditor links remain', async () => {
  const vite = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(vite, /quantum: new URL\('\.\/quantum\.html'/);
  assert.match(vite, /auditor: new URL\('\.\/auditor\.html'/);
  assert.match(vite, /main: new URL\('\.\/index\.html'/);
  assert.match(vite, /'\/api\/quantum'/);
  const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(vercel.rewrites.find((r) => r.source === '/quantum'), { source: '/quantum', destination: '/quantum.html' });
  assert.deepEqual(vercel.rewrites.at(-1), { source: '/(.*)', destination: '/index.html' });
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /href="\/quantum\.html">Quantum lab/);
  assert.match(main, /href="\/auditor\.html">Security auditor/);
  const html = await readFile(new URL('../quantum.html', import.meta.url), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /src\/quantum\/main\.js/);
});
