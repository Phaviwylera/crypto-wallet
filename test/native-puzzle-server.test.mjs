import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'seedlab-native-routes-'));
process.env.NATIVE_PUZZLE_REGISTRY_ROOT = path.join(temporary, 'registry');
process.env.NATIVE_PUZZLE_CAMPAIGN_ROOT = path.join(temporary, 'campaigns');
process.env.PZSOLVE_BIN = path.join(temporary, 'not-installed-pzsolve');
const { registerNativePuzzleRoutes } = await import('../server/native-puzzle.mjs');
const { createApp } = await import('../server/index.js');

test('production native routes plan blank bounds and reject invalid JSON', async () => {
  const app = new Hono();
  registerNativePuzzleRoutes(app);
  const planned = await app.request('/api/native-puzzle/plan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ puzzle: 1, lower: '', upper: '' }),
  });
  assert.equal(planned.status, 200);
  const plan = await planned.json();
  assert.deepEqual({ lower: plan.lower, upper: plan.upper, count: plan.count }, { lower: '1', upper: '1', count: '1' });
  const malformed = await app.request('/api/native-puzzle/plan', { method: 'POST', body: 'null' });
  assert.equal(malformed.status, 400);
});

test('production native routes expose completed coverage without requiring a runner for planning', async () => {
  await mkdir(process.env.NATIVE_PUZZLE_REGISTRY_ROOT, { recursive: true });
  const now = new Date().toISOString();
  const job = { campaign: 'p1-0123456789abcdef', puzzle: 1, lower: '1', upper: '1', count: '1', state: 'COMPLETED', createdAt: now, updatedAt: now, lastExitCode: 1, lastError: '' };
  await writeFile(path.join(process.env.NATIVE_PUZZLE_REGISTRY_ROOT, `${job.campaign}.json`), JSON.stringify(job));
  const app = new Hono();
  registerNativePuzzleRoutes(app);
  const covered = await app.request('/api/native-puzzle/plan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ puzzle: 1, lower: '', upper: '' }),
  });
  assert.equal(covered.status, 409);
  assert.match((await covered.json()).error, /already fully covered/);
  const status = await app.request('/api/native-puzzle/status');
  assert.equal(status.status, 200);
  const snapshot = await status.json();
  assert.equal(snapshot.runner.available, false);
  assert.equal(snapshot.jobs[0].state, 'COMPLETED');
  assert.equal(snapshot.jobs[0].done, '1');
  assert.equal('privateKey' in snapshot.jobs[0], false);
});

test('native process controls accept only the configured bearer token while status stays read-only', async () => {
  const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.NATIVE_PUZZLE_API_TOKEN = token;
  try {
    const app = new Hono();
    registerNativePuzzleRoutes(app);
    const body = JSON.stringify({ puzzle: 2, lower: '', upper: '' });
    const missing = await app.request('/api/native-puzzle/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(missing.status, 401);
    const wrong = await app.request('/api/native-puzzle/plan', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body,
    });
    assert.equal(wrong.status, 401);
    const authorized = await app.request('/api/native-puzzle/plan', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body,
    });
    assert.equal(authorized.status, 200);
    const status = await app.request('/api/native-puzzle/status');
    assert.equal(status.status, 200);
  } finally {
    delete process.env.NATIVE_PUZZLE_API_TOKEN;
  }
});

test('production entry point registers native GET routes before the SPA fallback', async () => {
  const app = createApp({ localRoutes: registerNativePuzzleRoutes });
  const response = await app.request('/api/native-puzzle/status');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  const snapshot = await response.json();
  assert.equal(Array.isArray(snapshot.jobs), true);
});

test.after(async () => {
  await rm(temporary, { recursive: true, force: true });
});
