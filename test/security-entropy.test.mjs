import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { analyzeEntropy, erfc, gammaQ, chiSquarePValue, monobit, runsTest, byteStatistics, serialCorrelation, repeatedBlocks, longestBitRun, MIN_ENTROPY_BYTES, MAX_ENTROPY_BYTES } from '../src/security/entropy-core.mjs';
import { generateEntropyFixture, mt19937, ENTROPY_FIXTURES } from '../src/security/entropy-fixtures.mjs';
import { decodeEntropyText, readEntropyFile, validateEntropyLength } from '../src/security/entropy-input.mjs';

const compress = async (bytes) => new Uint8Array(gzipSync(bytes));
const audit = (bytes, label = 'test') => analyzeEntropy(bytes, { compress, label, now: '2026-11-04T00:00:00.000Z' });

test('erfc and chi-square tails match known reference values', () => {
  assert.ok(Math.abs(erfc(0) - 1) < 1e-7);
  assert.ok(Math.abs(erfc(1) - 0.157299207) < 1e-7);
  assert.ok(Math.abs(chiSquarePValue(1, 1) - 0.317310508) < 1e-7);
  assert.ok(Math.abs(chiSquarePValue(2, 2) - Math.exp(-1)) < 1e-7);
  assert.ok(Math.abs(gammaQ(1, 1) - Math.exp(-1)) < 1e-7);
  assert.equal(gammaQ(2, 0), 1);
  assert.throws(() => gammaQ(0, 1), RangeError);
});

test('monobit detects all-zero and balanced bytes', () => {
  assert.equal(monobit(new Uint8Array(128)).ones, 0);
  assert.ok(monobit(new Uint8Array(128)).pValue < 1e-30);
  assert.equal(monobit(new Uint8Array(128).fill(0x55)).proportion, 0.5);
  assert.ok(monobit(new Uint8Array(128).fill(0x55)).pValue > 0.99);
});

test('runs test respects its bit-balance prerequisite', () => {
  const balanced = new Uint8Array(128).fill(0x55);
  const result = runsTest(balanced, 0.5);
  assert.equal(result.applicable, true);
  assert.equal(result.runs, 1024);
  assert.equal(runsTest(new Uint8Array(128), 0).applicable, false);
});

test('byte statistics expose bias and empirical entropy honestly', () => {
  const uniform = Uint8Array.from({ length: 4096 }, (_, i) => i % 256);
  const stats = byteStatistics(uniform);
  assert.equal(stats.chiSquare, 0);
  assert.equal(stats.shannonBitsPerByte, 8);
  assert.equal(stats.empiricalMinEntropyBitsPerByte, 8);
  assert.equal(stats.distinctBytes, 256);
  const zero = byteStatistics(new Uint8Array(4096));
  assert.equal(zero.shannonBitsPerByte, 0);
  assert.equal(zero.empiricalMinEntropyBitsPerByte, 0);
  assert.ok(zero.pValue < 1e-100);
});

test('serial correlation distinguishes counter structure from independent bytes', () => {
  const counter = Uint8Array.from({ length: 65536 }, (_, i) => i & 255);
  assert.ok(serialCorrelation(counter).coefficient > 0.97);
  assert.ok(serialCorrelation(counter).pValue < 0.001);
  assert.equal(serialCorrelation(new Uint8Array(1024)).pValue, null);
});

test('repeated blocks and longest runs are exact', () => {
  const bytes = new Uint8Array(1024).fill(7);
  assert.equal(repeatedBlocks(bytes, 32).completeBlocks, 32);
  assert.equal(repeatedBlocks(bytes, 32).duplicateBlocks, 31);
  assert.equal(repeatedBlocks(bytes, 16).duplicateBlocks, 63);
  assert.equal(longestBitRun(new Uint8Array(128)), 1024);
  assert.equal(longestBitRun(new Uint8Array(128).fill(0x55)), 1);
});

test('MT19937 matches the standard seed-5489 reference vector', () => {
  const next = mt19937(5489);
  assert.deepEqual(Array.from({ length: 5 }, next), [3499211612, 581869302, 3890346734, 3586334585, 545404204]);
});

test('all synthetic fixtures are deterministic except the CSPRNG control', () => {
  for (const fixture of ENTROPY_FIXTURES) {
    const a = generateEntropyFixture(fixture.id, 4096);
    const b = generateEntropyFixture(fixture.id, 4096);
    assert.equal(a.length, 4096);
    if (fixture.id === 'csprng') assert.notDeepEqual(a, b);
    else assert.deepEqual(a, b);
  }
  assert.throws(() => generateEntropyFixture('unknown'), /Unknown fixture/);
  assert.throws(() => generateEntropyFixture('counter', 10), RangeError);
});

test('repeating fixture produces a strong signal and redacted metadata only', async () => {
  const bytes = generateEntropyFixture('repeating', 65536);
  const result = await audit(bytes, 'repeating');
  assert.equal(result.verdict, 'statistical-signal');
  assert.ok(result.summary.signals >= 4);
  assert.equal(result.metrics.blocks32.duplicateBlocks, 2047);
  assert.match(result.input.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.input.bytes, 65536);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(bytes[0].toString(16).repeat(100)), false);
  assert.equal('bytes' in result.input && typeof result.input.bytes === 'object', false);
  assert.ok(result.limitations.length >= 4);
});

test('biased and counter fixtures are flagged', async () => {
  for (const id of ['biased', 'counter']) {
    const result = await audit(generateEntropyFixture(id, 65536), id);
    assert.equal(result.verdict, 'statistical-signal', id);
  }
});

test('CSPRNG control does not claim certification', async () => {
  const result = await audit(generateEntropyFixture('csprng', 65536), 'csprng');
  assert.notEqual(result.verdict, 'statistical-signal');
  assert.ok(result.limitations.some((line) => line.includes('not certified')));
});

test('fixed-seed PRNG demonstrates the limits of statistical testing', async () => {
  const result = await audit(generateEntropyFixture('mt19937', 65536), 'mt19937');
  assert.ok(result.limitations.some((line) => line.includes('passes') || line.includes('pass every')));
  assert.ok(result.metrics.bytes.shannonBitsPerByte > 7.9);
});

test('sample size boundaries and input types are enforced', async () => {
  await assert.rejects(analyzeEntropy(new Uint8Array(MIN_ENTROPY_BYTES - 1)), RangeError);
  await assert.rejects(analyzeEntropy(new Uint8Array(MAX_ENTROPY_BYTES + 1)), RangeError);
  await assert.rejects(analyzeEntropy([1, 2, 3]), TypeError);
  assert.throws(() => validateEntropyLength(0), /At least/);
  const result = await audit(new Uint8Array(MIN_ENTROPY_BYTES));
  assert.equal(result.checks.find((check) => check.id === 'sample-size').status, 'review');
});

test('hex, base64 and JSON byte inputs decode equivalently', () => {
  const bytes = Uint8Array.from({ length: 1024 }, (_, i) => i % 256);
  const hex = Buffer.from(bytes).toString('hex');
  assert.deepEqual(decodeEntropyText(`0x ${hex.match(/../g).join(' ')}`, 'hex'), bytes);
  assert.deepEqual(decodeEntropyText(Buffer.from(bytes).toString('base64'), 'base64'), bytes);
  assert.deepEqual(decodeEntropyText(JSON.stringify([...bytes]), 'json-bytes'), bytes);
});

test('malformed and secret-sized inputs are rejected', () => {
  assert.throws(() => decodeEntropyText('abc', 'hex'), /complete byte pairs/);
  assert.throws(() => decodeEntropyText('zzzz', 'hex'), /complete byte pairs/);
  assert.throws(() => decodeEntropyText('not base64!', 'base64'), /Invalid base64/);
  assert.throws(() => decodeEntropyText('[1,256]', 'json-bytes'), /integers from 0 to 255/);
  assert.throws(() => decodeEntropyText('00'.repeat(32), 'hex'), /At least 1024/);
  assert.throws(() => decodeEntropyText('00'.repeat(1024), 'binary'), /Choose hex/);
});

test('binary file import preserves bytes and enforces limits', async () => {
  const bytes = new Uint8Array(2048).fill(9);
  const file = { size: bytes.length, arrayBuffer: async () => bytes.buffer };
  assert.deepEqual(await readEntropyFile(file), bytes);
  await assert.rejects(readEntropyFile({ size: 1, arrayBuffer: async () => new Uint8Array(1).buffer }), /At least/);
});

test('compression check is explicitly skipped when unavailable', async () => {
  const result = await analyzeEntropy(new Uint8Array(2048), { compress: async () => null });
  const check = result.checks.find((item) => item.id === 'compression');
  assert.equal(check.status, 'skipped');
  assert.equal(result.metrics.compression.ratio, null);
});
