import test from 'node:test';
import assert from 'node:assert/strict';
import { generateScalarBatch, MAX_SCALAR_BATCH_SIZE, parseScalarBatchRange, scalarBatchRow } from '../src/scalar-wallet.js';

const derive = (scalar) => ({ address: `address-${scalar}`, publicKey: `public-${scalar}` });

test('batch range is inclusive and capped to keep browser generation bounded', () => {
  assert.equal(parseScalarBatchRange('1', '10000').count, 10000n);
  assert.equal(parseScalarBatchRange('7', '7').count, 1n);
  assert.throws(() => parseScalarBatchRange('1', '10001'), /at most 10,000/);
  assert.throws(() => parseScalarBatchRange('0', '10'));
  assert.equal(MAX_SCALAR_BATCH_SIZE, 10000);
});

test('generates every scalar in order as headerless address/public-key rows', async () => {
  const progress = [];
  const result = await generateScalarBatch({
    lower: '3', upper: '5', derive, yieldEvery: 1,
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.equal(result.count, 3);
  assert.equal(result.text, 'address-3\tpublic-3\naddress-4\tpublic-4\naddress-5\tpublic-5\n');
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
  assert.doesNotMatch(result.text, /Network:|scalar|private|SECURITY|address\tpublic_key/);
});

test('row formatter puts address first and rejects missing derivation values', () => {
  assert.equal(scalarBatchRow('0xabc', '0x04key'), '0xabc\t0x04key\n');
  assert.throws(() => scalarBatchRow('', '0x04key'), /did not return/);
  assert.throws(() => scalarBatchRow('0xabc', ''), /did not return/);
});

test('cancellation stops without returning a partial TXT', async () => {
  let calls = 0;
  await assert.rejects(generateScalarBatch({
    lower: '1', upper: '100', derive: (scalar) => { calls += 1; return derive(scalar); },
    shouldCancel: () => calls >= 2,
  }), { name: 'AbortError', message: 'Generation cancelled; no TXT was created.' });
  assert.equal(calls, 2);
});

test('invalid derivation settings fail before a result is accepted', async () => {
  await assert.rejects(generateScalarBatch({ lower: '1', upper: '2' }), /derivation function/);
  await assert.rejects(generateScalarBatch({ lower: '1', upper: '2', derive, yieldEvery: 0 }), /chunk size/);
  await assert.rejects(generateScalarBatch({ lower: '1', upper: '2', derive: () => ({ address: '', publicKey: '' }) }), /did not return/);
});
