import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveScalarWallet } from '../scripts/generate-scalar-wallets.mjs';
import { scalarBatchRow } from '../src/scalar-wallet.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINARY = process.env.SEEDLAB_ETH_EXPORT_BIN || path.join(ROOT, '.runtime', 'bin', 'seedlab-eth-export');
const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const skip = existsSync(BINARY) ? false : `Build ${BINARY} with npm run export:scalars:native:setup`;

function runNative(args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(BINARY, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Native exporter timed out: ${args.join(' ')}`));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

function expectedRows(lower, count) {
  return Array.from({ length: count }, (_, index) => {
    const derived = deriveScalarWallet(lower + BigInt(index));
    return scalarBatchRow(derived.address, derived.privateKey).slice(0, -1);
  });
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('native exporter self-test and license notices', { skip }, async () => {
  const selftest = await runNative(['--selftest']);
  assert.equal(selftest.code, 0, selftest.stderr);
  assert.match(selftest.stdout, /Keccak-256.*secp256k1.*EIP-55/);
  const version = await runNative(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /Copyright \(C\) 2026 Leonardo Boulay/);
  assert.match(version.stdout, /GNU AGPL version 3 or later/);
  assert.match(version.stdout, /modified exporter.*not the original pzsolve/i);
  assert.match(version.stdout, /NO WARRANTY/);
});

test('native parallel output exactly matches JavaScript and never overwrites', { skip }, async (t) => {
  const directory = await temporaryDirectory(t, 'native-scalar-exact-');
  const output = path.join(directory, 'exact.txt');
  const args = ['--start', '1', '--end', '513', '--output', output, '--threads', '4', '--chunk-size', '17'];
  const result = await runNative(args);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Complete: 513 rows, 56430 bytes/);
  assert.equal(existsSync(`${output}.partial`), false);
  const bytes = await readFile(output);
  assert.equal(bytes.length, 513 * 110);
  assert.deepEqual(bytes.toString('utf8').trimEnd().split('\n'), expectedRows(1n, 513));
  assert.equal((await stat(output)).mode & 0o777, 0o600);

  const second = await runNative(args);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /Output already exists/);
  assert.equal((await readFile(output)).length, 513 * 110);
});

test('native exporter includes the highest valid scalar in exact order', { skip }, async (t) => {
  const directory = await temporaryDirectory(t, 'native-scalar-high-');
  const output = path.join(directory, 'high.txt');
  const lower = N - 32n;
  const result = await runNative([
    '--start', String(lower), '--end', String(N - 1n), '--output', output,
    '--threads', '3', '--chunk-size', '5',
  ]);
  assert.equal(result.code, 0, result.stderr);
  const text = await readFile(output, 'utf8');
  assert.deepEqual(text.trimEnd().split('\n'), expectedRows(lower, 32));
  assert.ok(text.endsWith(`0x${(N - 1n).toString(16).padStart(64, '0')}\n`));
});

test('native exporter rejects invalid bounds before creating files', { skip }, async (t) => {
  const directory = await temporaryDirectory(t, 'native-scalar-invalid-');
  const cases = [
    ['0', '1'], ['2', '1'], ['1', String(N)], ['1', String(1n << 256n)], ['abc', '2'],
  ];
  for (const [index, [lower, upper]] of cases.entries()) {
    const output = path.join(directory, `invalid-${index}.txt`);
    const result = await runNative(['--start', lower, '--end', upper, '--output', output]);
    assert.notEqual(result.code, 0);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(`${output}.partial`), false);
  }
});

test('native exporter preserves an existing partial file', { skip }, async (t) => {
  const directory = await temporaryDirectory(t, 'native-scalar-partial-');
  const output = path.join(directory, 'wallet.txt');
  await writeFile(`${output}.partial`, 'incomplete sentinel', { mode: 0o600 });
  const result = await runNative(['--start', '1', '--end', '2', '--output', output]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Cannot create partial output/);
  assert.equal(await readFile(`${output}.partial`, 'utf8'), 'incomplete sentinel');
  assert.equal(existsSync(output), false);
});

test('SIGTERM leaves only an incomplete partial and never a completed TXT', { skip }, async (t) => {
  const directory = await temporaryDirectory(t, 'native-scalar-cancel-');
  const output = path.join(directory, 'cancelled.txt');
  const child = spawn(BINARY, [
    '--start', '1', '--end', '100000000', '--output', output,
    '--threads', '1', '--chunk-size', '4096',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  const deadline = Date.now() + 5000;
  while (!existsSync(`${output}.partial`)) {
    if (Date.now() > deadline) throw new Error('Partial output was not created.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  child.kill('SIGTERM');
  const result = await closed;
  assert.equal(result.code, 1, stderr);
  assert.equal(result.signal, null);
  assert.match(stderr, /Export interrupted; the \.partial file is incomplete/);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.partial`), true);
  assert.equal((await stat(`${output}.partial`)).mode & 0o777, 0o600);
});

test('native random sample exports exact unique in-range rows that match JavaScript derivation', { skip }, async (t) => {
  const directory = await temporaryDirectory(t, 'native-scalar-random-');
  const output = path.join(directory, 'random.txt');
  const result = await runNative([
    '--start', '1', '--end', '1000', '--sample', '100', '--output', output, '--threads', '2', '--chunk-size', '17',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Complete: 100 rows, 11000 bytes/);
  assert.equal(existsSync(`${output}.partial`), false);
  const text = await readFile(output, 'utf8');
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 100);
  const keys = lines.map((line) => line.split('\t')[1]);
  assert.equal(new Set(keys).size, 100);
  for (const line of lines) {
    const [address, key] = line.split('\t');
    const scalar = BigInt(key);
    assert.ok(scalar >= 1n && scalar <= 1000n);
    const expected = deriveScalarWallet(scalar);
    assert.equal(address, expected.address);
    assert.equal(key, expected.privateKey);
  }
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test('native random sample works when the inclusive range is wider than the host output limit', { skip }, async (t) => {
  const directory = await temporaryDirectory(t, 'native-scalar-random-wide-');
  // The reported UI case: a ~1e56-wide inclusive range with only 5,000 entries.
  const lower = 8886537567565632563756237567736572356383562336563565237857n;
  const upper = 9886537567565632563756237567736572356383562336563599999999n;
  const output = path.join(directory, 'wide-random.txt');
  const result = await runNative([
    '--start', String(lower), '--end', String(upper), '--sample', '5000',
    '--output', output, '--threads', '2', '--chunk-size', '512',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Complete: 5000 rows, 550000 bytes/);
  assert.equal(existsSync(`${output}.partial`), false);
  const text = await readFile(output, 'utf8');
  assert.equal(Buffer.byteLength(text), 5000 * 110);
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 5000);
  const keys = lines.map((line) => line.split('\t')[1]);
  assert.equal(new Set(keys).size, 5000);
  for (const line of lines) {
    const [address, key] = line.split('\t');
    const scalar = BigInt(key);
    assert.ok(scalar >= lower && scalar <= upper);
    const expected = deriveScalarWallet(scalar);
    assert.equal(address, expected.address);
    assert.equal(key, expected.privateKey);
  }
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test('native random sample works for ranges wider than 64 bits and for u64 widths above the output limit', { skip }, async (t) => {
  const directory = await temporaryDirectory(t, 'native-scalar-random-width-');
  const cases = [
    // Width exceeds uint64 entirely.
    [String(N - (1n << 100n)), String(N - 1n), '64'],
    // Width fits uint64 but exceeds LLONG_MAX / 110 (the host output limit).
    ['1', '100000000000000000', '32'],
  ];
  for (const [index, [lower, upper, sample]] of cases.entries()) {
    const output = path.join(directory, `width-${index}.txt`);
    const result = await runNative([
      '--start', lower, '--end', upper, '--sample', sample, '--output', output, '--threads', '2',
    ]);
    assert.equal(result.code, 0, result.stderr);
    const lines = (await readFile(output, 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length, Number(sample));
    assert.equal(new Set(lines.map((line) => line.split('\t')[1])).size, Number(sample));
    for (const line of lines) {
      const scalar = BigInt(line.split('\t')[1]);
      assert.ok(scalar >= BigInt(lower) && scalar <= BigInt(upper));
    }
  }
});

test('native all-entries export still rejects ranges wider than the host output limit', { skip }, async (t) => {
  const directory = await temporaryDirectory(t, 'native-scalar-all-wide-');
  const output = path.join(directory, 'too-wide.txt');
  const result = await runNative([
    '--start', '8886537567565632563756237567736572356383562336563565237857',
    '--end', '9886537567565632563756237567736572356383562336563599999999',
    '--output', output,
  ]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /too large for this host/);
  assert.match(result.stderr, /--sample/);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.partial`), false);
});

test('native random sample rejects counts outside the inclusive range before creating files', { skip }, async (t) => {
  const directory = await temporaryDirectory(t, 'native-scalar-random-invalid-');
  for (const [index, sample] of ['0', '1001'].entries()) {
    const output = path.join(directory, `invalid-${index}.txt`);
    const result = await runNative(['--start', '1', '--end', '1000', '--sample', sample, '--output', output]);
    assert.notEqual(result.code, 0);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(`${output}.partial`), false);
  }
});
