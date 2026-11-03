import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportScalarWalletFile, streamScalarWalletExport } from '../scripts/generate-scalar-wallets.mjs';

const privateKeyFor = (scalar) => `0x${scalar.toString(16).padStart(64, '0')}`;

test('streaming export has no former 50,000-row cap and flushes bounded chunks', async () => {
  let rows = 0;
  let writes = 0;
  let firstChunk = '';
  let lastChunk = '';
  const result = await streamScalarWalletExport({
    lower: '1', upper: '50001', chunkSize: 1000,
    derive: (scalar) => ({ address: `address-${scalar}`, privateKey: privateKeyFor(scalar) }),
    write: async (chunk) => {
      writes += 1;
      rows += chunk.split('\n').length - 1;
      if (!firstChunk) firstChunk = chunk;
      lastChunk = chunk;
    },
  });
  assert.equal(result.count, 50001n);
  assert.equal(rows, 50001);
  assert.equal(writes, 51);
  assert.ok(firstChunk.startsWith(`address-1\t${privateKeyFor(1n)}\n`));
  assert.equal(lastChunk, `address-50001\t${privateKeyFor(50001n)}\n`);
});

test('file export writes real Ethereum rows atomically and never overwrites', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scalar-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'ethereum-1-3.txt');
  const result = await exportScalarWalletFile({ lower: '1', upper: '3', output });
  const text = await readFile(output, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(result.count, 3n);
  assert.equal(result.bytes, Buffer.byteLength(text));
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf\t${privateKeyFor(1n)}`);
  lines.forEach((line, index) => assert.equal(line.split('\t')[1], privateKeyFor(BigInt(index + 1))));
  assert.equal(existsSync(`${output}.partial`), false);
  await assert.rejects(exportScalarWalletFile({ lower: '1', upper: '3', output }), /Output already exists/);
});

test('cancellation cannot be mistaken for a completed TXT', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scalar-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'cancelled.txt');
  let checks = 0;
  await assert.rejects(exportScalarWalletFile({
    lower: '1', upper: '100', output,
    shouldCancel: () => { checks += 1; return checks >= 3; },
  }), { name: 'AbortError' });
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.partial`), true);
});
