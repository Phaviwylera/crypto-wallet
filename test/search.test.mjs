import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchRange, partitionSearchRange, MAX_SEARCH_SCALAR } from '../src/search-range.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';

test('validates inclusive scalar ranges', () => {
  assert.deepEqual(parseSearchRange('5', '5'), { start: 5n, end: 5n, count: 1n });
  assert.equal(parseSearchRange('1', MAX_SEARCH_SCALAR.toString()).end, MAX_SEARCH_SCALAR);
  assert.equal(parseSearchRange('1000000001', '1000000000000000000001').start, 1000000001n);
  for (const [a, b] of [['0','1'], ['3','2'], ['1.0','5'], ['1',(MAX_SEARCH_SCALAR + 1n).toString()], ['', '1']]) assert.throws(() => parseSearchRange(a,b));
});
test('partitions cover exactly the range, including tiny and uneven ranges', () => {
  for (const [start, end, n] of [[1n, 1n, 8], [10n, 20n, 4], [1n, 100n, 8]]) {
    const chunks = partitionSearchRange(start, end, n);
    assert.equal(chunks[0].start, start); assert.equal(chunks.at(-1).end, end);
    chunks.forEach((c, i) => { assert.ok(c.start <= c.end); if (i) assert.equal(c.start, chunks[i-1].end + 1n); });
  }
});
test('worker finds inclusive endpoint and completes a miss', async () => {
  let resolve;
  globalThis.self = { postMessage: (message) => { if (message.type !== 'progress') resolve(message); } };
  await import('../src/search-worker.js');
  const payload = keccak_256(secp256k1.Point.BASE.multiply(3n).toBytes(false).slice(1)).slice(12);
  const run = (start, end) => new Promise((r) => { resolve = r; self.onmessage({ data: { workerId: 0, networkId: 'ethereum', targetBytes: payload, start, end, chunkSize: 2 } }); });
  const match = await run(1n, 3n); assert.equal(match.type, 'match'); assert.equal(match.scalar, 3n); assert.equal(match.tested, 3n);
  const miss = await run(4n, 5n); assert.equal(miss.type, 'done'); assert.equal(miss.tested, 2n);
});
test('address worker checks the last valid scalar', async () => {
  const point = secp256k1.Point.BASE.multiply(MAX_SEARCH_SCALAR);
  const payload = keccak_256(point.toBytes(false).slice(1)).slice(12);
  const result = await new Promise((resolve) => {
    globalThis.self.postMessage = (message) => { if (message.type !== 'progress') resolve(message); };
    self.onmessage({ data: { workerId: 0, networkId: 'ethereum', targetBytes: payload, start: MAX_SEARCH_SCALAR, end: MAX_SEARCH_SCALAR, chunkSize: 2 } });
  });
  assert.equal(result.type, 'match');
  assert.equal(result.scalar, MAX_SEARCH_SCALAR);
});
test('batched worker checks profiles and reports the correct target across chunks', async () => {
  const point = secp256k1.Point.BASE.multiply(7n);
  const hash160 = (data) => ripemd160(sha256(data));
  const keyHash = hash160(point.toBytes(true));
  const evm = keccak_256(point.toBytes(false).slice(1)).slice(12);
  const nested = hash160(new Uint8Array([0, 20, ...keyHash]));
  const even = point.toBytes(true)[0] === 3 ? point.negate() : point;
  const x = even.toBytes(true).slice(1);
  const tagHash = sha256(new TextEncoder().encode('TapTweak'));
  const tweak = BigInt('0x' + Buffer.from(sha256(new Uint8Array([...tagHash, ...tagHash, ...x]))).toString('hex'));
  const taproot = even.add(secp256k1.Point.BASE.multiply(tweak)).toBytes(true).slice(1);
  for (const [networkId, target] of Object.entries({ ethereum: evm, bnb: evm, tron: evm, bitcoin: keyHash, bitcoinLegacy: keyHash, bnbBeacon: keyHash, bitcoinNested: nested, bitcoinTaproot: taproot })) {
    const result = await new Promise((resolve) => {
      globalThis.self.postMessage = (message) => { if (message.type !== 'progress') resolve(message); };
      self.onmessage({ data: { workerId: 0, networkId, targetBytesList: [new Uint8Array(target.length), target], start: 5n, end: 9n, chunkSize: 2 } });
    });
    assert.equal(result.type, 'match', networkId);
    assert.equal(result.scalar, 7n, networkId);
    assert.equal(result.tested, 3n, networkId);
    assert.equal(result.targetIndex, 1, networkId);
    assert.equal(result.publicKey, '0x' + Buffer.from(point.toBytes(false)).toString('hex'), networkId);
  }
});
test('worker errors inside a chunk are reported', async () => {
  const result = await new Promise((resolve) => {
    globalThis.self.postMessage = (message) => resolve(message);
    self.onmessage({ data: { workerId: 3, networkId: 'unsupported', targetBytes: new Uint8Array(20), start: 1n, end: 2n, chunkSize: 2 } });
  });
  assert.equal(result.type, 'error'); assert.equal(result.workerId, 3);
});
