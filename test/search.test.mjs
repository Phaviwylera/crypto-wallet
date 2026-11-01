import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchRange, partitionSearchRange } from '../src/search-range.js';
import { runPollardKangarooDemo } from '../src/pollard-kangaroo-demo.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

test('validates inclusive scalar ranges', () => {
  assert.deepEqual(parseSearchRange('5', '5'), { start: 5n, end: 5n, count: 1n });
  for (const [a, b] of [['0','1'], ['3','2'], ['1.0','5'], ['1','1000000000000000000001'], ['', '1']]) assert.throws(() => parseSearchRange(a,b));
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
test('toy kangaroo collision verifies the synthetic point', () => {
  const result = runPollardKangarooDemo();
  assert.equal(result.recovered, '345678'); assert.equal(result.verified, true);
  assert.equal(BigInt(result.lower) + BigInt(result.width) + BigInt(result.collision.tameDistance) - BigInt(result.collision.wildDistance), BigInt(result.recovered));
});
