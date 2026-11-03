import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { computeAddress } from 'ethers';
import { generateScalarBatch, parseScalarBatchRange, scalarBatchRow } from '../src/scalar-wallet.js';

const privateKeyFor = (scalar) => `0x${scalar.toString(16).padStart(64, '0')}`;
const derive = (scalar) => ({ address: `address-${scalar}`, privateKey: privateKeyFor(scalar) });

test('batch range is inclusive with no artificial row cap', () => {
  assert.equal(parseScalarBatchRange('1', '50000').count, 50000n);
  assert.equal(parseScalarBatchRange('1', '50001').count, 50001n);
  assert.equal(parseScalarBatchRange('1', '10000000').count, 10000000n);
  assert.equal(parseScalarBatchRange('10000000000', '10000010000').count, 10001n);
  assert.equal(parseScalarBatchRange('7', '7').count, 1n);
  assert.throws(() => parseScalarBatchRange('0', '10'));
});

test('generates every scalar in order as headerless address/private-key rows', async () => {
  const progress = [];
  const result = await generateScalarBatch({
    lower: '3', upper: '5', derive, yieldEvery: 1,
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.equal(result.count, 3);
  assert.equal(result.text, `address-3\t${privateKeyFor(3n)}\naddress-4\t${privateKeyFor(4n)}\naddress-5\t${privateKeyFor(5n)}\n`);
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
  assert.doesNotMatch(result.text, /Network:|scalar|SECURITY|public_key/);
});

test('row formatter puts address first and requires a 32-byte private key', () => {
  assert.equal(scalarBatchRow('0xabc', privateKeyFor(1n)), `0xabc\t${privateKeyFor(1n)}\n`);
  assert.throws(() => scalarBatchRow('', privateKeyFor(1n)), /did not return/);
  assert.throws(() => scalarBatchRow('0xabc', ''), /did not return/);
  assert.throws(() => scalarBatchRow('0xabc', '0x04key'), /32-byte/);
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
  await assert.rejects(generateScalarBatch({ lower: '1', upper: '2', derive: () => ({ address: '', privateKey: '' }) }), /did not return/);
});

test('real Ethereum rows pair each address with its exact scalar private key', async () => {
  const result = await generateScalarBatch({
    lower: '1', upper: '3', yieldEvery: 1,
    derive: (scalar) => {
      const privateKey = privateKeyFor(scalar);
      const privateBytes = Uint8Array.from(Buffer.from(privateKey.slice(2), 'hex'));
      const publicKey = `0x${Buffer.from(secp256k1.getPublicKey(privateBytes, false)).toString('hex')}`;
      return { address: computeAddress(publicKey), privateKey };
    },
  });
  const lines = result.text.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf\t${privateKeyFor(1n)}`);
  lines.forEach((line, index) => assert.equal(line.split('\t')[1], privateKeyFor(BigInt(index + 1))));
});
