import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerNativeScalarExportRoutes } from '../server/native-scalar-export.mjs';
import { deriveScalarWallet } from '../scripts/generate-scalar-wallets.mjs';
import { scalarBatchRow } from '../src/scalar-wallet.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINARY = process.env.SEEDLAB_ETH_EXPORT_BIN || path.join(ROOT, '.runtime', 'bin', 'seedlab-eth-export');
const TOKEN = 'native-scalar-test-token';
const skip = existsSync(BINARY) ? false : `Build ${BINARY} with npm run export:scalars:native:setup`;
const authorization = { authorization: `Bearer ${TOKEN}` };

async function fixture(t) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'native-scalar-api-'));
  const app = new Hono();
  const service = registerNativeScalarExportRoutes(app, { binary: BINARY, outputRoot, retentionMs: 600000 });
  t.after(async () => {
    service.shutdown();
    await rm(outputRoot, { recursive: true, force: true });
  });
  return { app, service, outputRoot };
}

async function waitForState(app, id, states, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await app.request(`/api/native-scalar-export/status?id=${encodeURIComponent(id)}`, { headers: authorization });
    assert.equal(response.status, 200);
    const { job } = await response.json();
    if (states.includes(job.state)) return job;
    if (job.state === 'ERROR') assert.fail(job.error);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${states.join('/')}.`);
}

test('authenticated native API streams exact rows and deletes only the requested job', { skip }, async (t) => {
  const previousToken = process.env.NATIVE_PUZZLE_API_TOKEN;
  process.env.NATIVE_PUZZLE_API_TOKEN = TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env.NATIVE_PUZZLE_API_TOKEN;
    else process.env.NATIVE_PUZZLE_API_TOKEN = previousToken;
  });
  const { app, outputRoot } = await fixture(t);

  const unauthorized = await app.request('/api/native-scalar-export/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lower: '1', upper: '256' }),
  });
  assert.equal(unauthorized.status, 401);
  const invalid = await app.request('/api/native-scalar-export/start', {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' }, body: JSON.stringify({ lower: '0', upper: '256' }),
  });
  assert.equal(invalid.status, 400);

  const startedResponse = await app.request('/api/native-scalar-export/start', {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ lower: '1', upper: '256', threads: 2 }),
  });
  assert.equal(startedResponse.status, 202);
  const { job: started } = await startedResponse.json();
  const completed = await waitForState(app, started.id, ['COMPLETED']);
  assert.equal(completed.count, '256');
  assert.equal(completed.completed, '256');
  assert.equal(completed.bytes, String(256 * 110));
  assert.equal(completed.canDownload, true);
  assert.ok(completed.ratePerSecond > 0);
  assert.equal(completed.fileName, 'address-private-keys-ethereum-1-256.txt');
  assert.equal(Object.hasOwn(completed, 'output'), false);
  assert.equal(Object.hasOwn(completed, 'partial'), false);

  const expected = Array.from({ length: 256 }, (_, index) => {
    const derived = deriveScalarWallet(BigInt(index + 1));
    return scalarBatchRow(derived.address, derived.privateKey);
  }).join('');
  const output = path.join(outputRoot, `${started.id}.txt`);
  assert.equal(await readFile(output, 'utf8'), expected);
  assert.equal((await stat(output)).mode & 0o777, 0o600);

  const deniedDownload = await app.request(`/api/native-scalar-export/download?id=${started.id}`);
  assert.equal(deniedDownload.status, 401);
  const download = await app.request(`/api/native-scalar-export/download?id=${started.id}`, { headers: authorization });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-length'), String(256 * 110));
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="address-private-keys-ethereum-1-256\.txt"$/);
  assert.equal(await download.text(), expected);

  const removed = await app.request('/api/native-scalar-export/delete', {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' }, body: JSON.stringify({ id: started.id }),
  });
  assert.equal(removed.status, 200);
  assert.equal(existsSync(output), false);
  const missing = await app.request(`/api/native-scalar-export/download?id=${started.id}`, { headers: authorization });
  assert.equal(missing.status, 404);
});

test('native API permits one active export and cancellation never publishes a TXT', { skip }, async (t) => {
  const previousToken = process.env.NATIVE_PUZZLE_API_TOKEN;
  process.env.NATIVE_PUZZLE_API_TOKEN = TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env.NATIVE_PUZZLE_API_TOKEN;
    else process.env.NATIVE_PUZZLE_API_TOKEN = previousToken;
  });
  const { app, outputRoot } = await fixture(t);
  const startBody = JSON.stringify({ lower: '1', upper: '100000000', threads: 1 });
  const startedResponse = await app.request('/api/native-scalar-export/start', {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' }, body: startBody,
  });
  assert.equal(startedResponse.status, 202);
  const { job: started } = await startedResponse.json();
  const conflict = await app.request('/api/native-scalar-export/start', {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' }, body: startBody,
  });
  assert.equal(conflict.status, 409);

  const stopped = await app.request('/api/native-scalar-export/stop', {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' }, body: JSON.stringify({ id: started.id }),
  });
  assert.equal(stopped.status, 202);
  const cancelled = await waitForState(app, started.id, ['CANCELLED']);
  assert.equal(cancelled.canDownload, false);
  assert.equal(existsSync(path.join(outputRoot, `${started.id}.txt`)), false);
  const download = await app.request(`/api/native-scalar-export/download?id=${started.id}`, { headers: authorization });
  assert.equal(download.status, 404);

  await app.request('/api/native-scalar-export/delete', {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' }, body: JSON.stringify({ id: started.id }),
  });
  assert.equal(existsSync(path.join(outputRoot, `${started.id}.txt.partial`)), false);
});

test('status cleanup removes inaccessible UUID orphans but not unrelated files', { skip }, async (t) => {
  const previousToken = process.env.NATIVE_PUZZLE_API_TOKEN;
  process.env.NATIVE_PUZZLE_API_TOKEN = TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env.NATIVE_PUZZLE_API_TOKEN;
    else process.env.NATIVE_PUZZLE_API_TOKEN = previousToken;
  });
  const { app, outputRoot } = await fixture(t);
  const orphan = path.join(outputRoot, '123e4567-e89b-42d3-a456-426614174000.txt.partial');
  const unrelated = path.join(outputRoot, 'notes.txt');
  await writeFile(orphan, 'incomplete orphan', { mode: 0o600 });
  await writeFile(unrelated, 'not an export', { mode: 0o600 });
  const response = await app.request('/api/native-scalar-export/status', { headers: authorization });
  assert.equal(response.status, 200);
  assert.equal(existsSync(orphan), false);
  assert.equal(await readFile(unrelated, 'utf8'), 'not an export');
});

test('authenticated native API can generate and download an exact random sample', { skip }, async (t) => {
  const previousToken = process.env.NATIVE_PUZZLE_API_TOKEN;
  process.env.NATIVE_PUZZLE_API_TOKEN = TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env.NATIVE_PUZZLE_API_TOKEN;
    else process.env.NATIVE_PUZZLE_API_TOKEN = previousToken;
  });
  const { app } = await fixture(t);
  const startedResponse = await app.request('/api/native-scalar-export/start', {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ lower: '1', upper: '1000', mode: 'random', sampleCount: '64', threads: 2 }),
  });
  assert.equal(startedResponse.status, 202);
  const { job: started } = await startedResponse.json();
  assert.equal(started.mode, 'random');
  assert.equal(started.sampleCount, '64');
  const completed = await waitForState(app, started.id, ['COMPLETED']);
  assert.equal(completed.count, '64');
  assert.equal(completed.bytes, String(64 * 110));
  assert.equal(completed.fileName, 'address-private-keys-ethereum-1-1000-random-64.txt');
  const download = await app.request(`/api/native-scalar-export/download?id=${started.id}`, { headers: authorization });
  assert.equal(download.status, 200);
  const lines = (await download.text()).trimEnd().split('\n');
  assert.equal(lines.length, 64);
  const keys = lines.map((line) => line.split('\t')[1]);
  assert.equal(new Set(keys).size, 64);
  for (const key of keys) assert.ok(BigInt(key) >= 1n && BigInt(key) <= 1000n);
});
