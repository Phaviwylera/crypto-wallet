import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerNativeScalarExportRoutes } from '../server/native-scalar-export.mjs';
import { deriveScalarWallet } from '../scripts/generate-scalar-wallets.mjs';
import { scalarBatchRow } from '../src/scalar-wallet.js';
import {
  NATIVE_SCALAR_EXPORT_VERSION,
  NATIVE_WIDE_RANGE_SAMPLE_CAPABILITY,
  parseNativeScalarExportVersion,
} from '../src/native-scalar-export-runtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINARY = process.env.SEEDLAB_ETH_EXPORT_BIN || path.join(ROOT, '.runtime', 'bin', 'seedlab-eth-export');
const TOKEN = 'native-scalar-test-token';
const skip = existsSync(BINARY) ? false : `Build ${BINARY} with npm run export:scalars:native:setup`;
const authorization = { authorization: `Bearer ${TOKEN}` };

async function fixture(t, { binary = BINARY } = {}) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'native-scalar-api-'));
  const app = new Hono();
  const service = registerNativeScalarExportRoutes(app, { binary, outputRoot, retentionMs: 600000 });
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

test('native export health reports the verified exporter version and wide-range capability', { skip }, async (t) => {
  const { app } = await fixture(t);
  const health = await app.request('/api/native-scalar-export/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'private, no-store');
  const payload = await health.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.expectedVersion, NATIVE_SCALAR_EXPORT_VERSION);
  assert.equal(payload.runner.available, true);
  assert.equal(payload.runner.ready, true);
  assert.equal(payload.runner.version, NATIVE_SCALAR_EXPORT_VERSION);
  assert.equal(payload.runner.supportsWideRangeSample, true);
  assert.ok(payload.runner.capabilities.includes(NATIVE_WIDE_RANGE_SAMPLE_CAPABILITY));
  assert.equal(payload.error, '');
  assert.equal(JSON.stringify(payload).includes(ROOT), false);

  const status = await app.request('/api/native-scalar-export/status', { headers: authorization });
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).runner, payload.runner);
});

test('native export health rejects a stale exporter and notices an atomic rebuild without restarting the API', async (t) => {
  const previousToken = process.env.NATIVE_PUZZLE_API_TOKEN;
  process.env.NATIVE_PUZZLE_API_TOKEN = TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env.NATIVE_PUZZLE_API_TOKEN;
    else process.env.NATIVE_PUZZLE_API_TOKEN = previousToken;
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-scalar-stale-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'mock-export');
  const oldScript = '#!/usr/bin/env node\nconsole.log("seedlab-eth-export 1.0.0 (modified work based on pzsolve pzcore)");\n';
  await writeFile(binary, oldScript, { mode: 0o700 });
  const { app, service } = await fixture(t, { binary });

  const stale = await app.request('/api/native-scalar-export/health');
  assert.equal(stale.status, 503);
  const stalePayload = await stale.json();
  assert.equal(stalePayload.ok, false);
  assert.equal(stalePayload.runner.version, '1.0.0');
  assert.equal(stalePayload.runner.supportsWideRangeSample, false);
  assert.match(stalePayload.error, /older native exporter/i);

  const started = await app.request('/api/native-scalar-export/start', {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({
      lower: '8886537567565632563756237567736572356383562336563565237857',
      upper: '9886537567565632563756237567736572356383562336563599999999',
      mode: 'random', sampleCount: '500000', threads: 2,
    }),
  });
  assert.equal(started.status, 503);
  assert.match((await started.json()).error, /Rebuild and restart/i);
  assert.equal(service.jobs.size, 0);

  const next = path.join(directory, 'mock-export.next');
  await writeFile(next, `#!/usr/bin/env node\nconsole.log("seedlab-eth-export ${NATIVE_SCALAR_EXPORT_VERSION} (modified work based on pzsolve pzcore)");\nconsole.log("Native capabilities: all-entries,random-sample,${NATIVE_WIDE_RANGE_SAMPLE_CAPABILITY}");\n`, { mode: 0o700 });
  await chmod(next, 0o700);
  await rename(next, binary);
  const rebuilt = await app.request('/api/native-scalar-export/health');
  assert.equal(rebuilt.status, 200);
  const rebuiltPayload = await rebuilt.json();
  assert.equal(rebuiltPayload.ok, true);
  assert.equal(rebuiltPayload.runner.version, NATIVE_SCALAR_EXPORT_VERSION);
  assert.equal(rebuiltPayload.runner.supportsWideRangeSample, true);
});

test('native export health reports a missing exporter without exposing its path', async (t) => {
  const { app } = await fixture(t, { binary: path.join(os.tmpdir(), 'seedlab-missing-exporter-for-test') });
  const health = await app.request('/api/native-scalar-export/health');
  assert.equal(health.status, 503);
  const payload = await health.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.runner.available, false);
  assert.match(payload.error, /not installed/i);
  assert.equal(JSON.stringify(payload).includes('seedlab-missing-exporter-for-test'), false);
});

test('native version parsing requires the explicit wide-range capability', () => {
  const current = parseNativeScalarExportVersion(`seedlab-eth-export ${NATIVE_SCALAR_EXPORT_VERSION} (modified work)\nNative capabilities: all-entries,random-sample,${NATIVE_WIDE_RANGE_SAMPLE_CAPABILITY}\n`);
  assert.equal(current.version, NATIVE_SCALAR_EXPORT_VERSION);
  assert.equal(current.supportsWideRangeSample, true);
  const old = parseNativeScalarExportVersion('seedlab-eth-export 1.0.0 (modified work)\n');
  assert.equal(old.version, '1.0.0');
  assert.equal(old.supportsWideRangeSample, false);
  assert.deepEqual(old.capabilities, []);
  assert.equal(parseNativeScalarExportVersion('not an exporter').version, 'unknown');
});

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

test('authenticated native API streams the same completed job as TXT or CSV without regenerating', { skip }, async (t) => {
  const previousToken = process.env.NATIVE_PUZZLE_API_TOKEN;
  process.env.NATIVE_PUZZLE_API_TOKEN = TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env.NATIVE_PUZZLE_API_TOKEN;
    else process.env.NATIVE_PUZZLE_API_TOKEN = previousToken;
  });
  const { app, outputRoot } = await fixture(t);
  const startedResponse = await app.request('/api/native-scalar-export/start', {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ lower: '1', upper: '256', threads: 2 }),
  });
  assert.equal(startedResponse.status, 202);
  const { job: started } = await startedResponse.json();
  const completed = await waitForState(app, started.id, ['COMPLETED']);
  assert.equal(completed.bytes, String(256 * 110));
  assert.equal(completed.fileName, 'address-private-keys-ethereum-1-256.txt');

  const tsv = await readFile(path.join(outputRoot, `${started.id}.txt`), 'utf8');
  const expectedCsv = 'address,private_key\r\n' + tsv.split('\n').filter(Boolean).map((line) => line.replace('\t', ',')).join('\r\n') + '\r\n';

  const txt = await app.request(`/api/native-scalar-export/download?id=${started.id}`, { headers: authorization });
  assert.equal(txt.status, 200);
  assert.equal(txt.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(txt.headers.get('content-length'), String(256 * 110));
  assert.match(txt.headers.get('content-disposition'), /address-private-keys-ethereum-1-256\.txt/);
  assert.equal(await txt.text(), tsv);

  const csv = await app.request(`/api/native-scalar-export/download?id=${started.id}&format=csv`, { headers: authorization });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(csv.headers.get('content-length'), String(21 + 256 * 111));
  assert.match(csv.headers.get('content-disposition'), /address-private-keys-ethereum-1-256\.csv/);
  assert.equal(csv.headers.get('cache-control'), 'private, no-store');
  const csvText = await csv.text();
  assert.equal(csvText, expectedCsv);
  assert.equal(Buffer.byteLength(csvText), 21 + 256 * 111);
  assert.equal(csvText.split('\r\n').filter(Boolean).length, 257);

  // The canonical server copy remains headerless TSV after a CSV download.
  assert.equal(await readFile(path.join(outputRoot, `${started.id}.txt`), 'utf8'), tsv);
  assert.equal(existsSync(path.join(outputRoot, `${started.id}.csv`)), false);

  const invalid = await app.request(`/api/native-scalar-export/download?id=${started.id}&format=xlsx`, { headers: authorization });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /TXT or CSV/);
});

test('authenticated native API accepts a small random sample from a range wider than the host output limit', { skip }, async (t) => {
  const previousToken = process.env.NATIVE_PUZZLE_API_TOKEN;
  process.env.NATIVE_PUZZLE_API_TOKEN = TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env.NATIVE_PUZZLE_API_TOKEN;
    else process.env.NATIVE_PUZZLE_API_TOKEN = previousToken;
  });
  const { app } = await fixture(t);
  const lower = '8886537567565632563756237567736572356383562336563565237857';
  const upper = '9886537567565632563756237567736572356383562336563599999999';
  const startedResponse = await app.request('/api/native-scalar-export/start', {
    method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ lower, upper, mode: 'random', sampleCount: '5000', threads: 2 }),
  });
  assert.equal(startedResponse.status, 202);
  const { job: started } = await startedResponse.json();
  assert.equal(started.count, '5000');
  assert.equal(started.totalBytes, String(5000 * 110));
  const completed = await waitForState(app, started.id, ['COMPLETED'], 30000);
  assert.equal(completed.completed, '5000');
  assert.equal(completed.bytes, String(5000 * 110));

  const download = await app.request(`/api/native-scalar-export/download?id=${started.id}`, { headers: authorization });
  assert.equal(download.status, 200);
  const lines = (await download.text()).trimEnd().split('\n');
  assert.equal(lines.length, 5000);
  const keys = lines.map((line) => line.split('\t')[1]);
  assert.equal(new Set(keys).size, 5000);
  for (const key of keys) assert.ok(BigInt(key) >= BigInt(lower) && BigInt(key) <= BigInt(upper));
  for (const line of [lines[0], lines[2500], lines[4999]]) {
    const [address, key] = line.split('\t');
    const expected = deriveScalarWallet(BigInt(key));
    assert.equal(address, expected.address);
    assert.equal(key, expected.privateKey);
  }

  const csv = await app.request(`/api/native-scalar-export/download?id=${started.id}&format=csv`, { headers: authorization });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get('content-length'), String(21 + 5000 * 111));
  const csvRows = (await csv.text()).trimEnd().split('\r\n');
  assert.equal(csvRows.length, 5001);
  assert.equal(csvRows[0], 'address,private_key');
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
