import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createPublicKeySearchPool, partitionTargets } from '../src/public-key-search-pool.js';
import { estimateSearchWork } from '../src/public-key-search.js';

const header = 'address\ttransaction_hash\tpublic_key_uncompressed\tstatus';
function row(n) {
  const pub = secp256k1.Point.BASE.multiply(BigInt(n)).toBytes(false);
  const address = Buffer.from(keccak_256(pub.slice(1)).slice(12)).toString('hex');
  return `0x${address}\t0x${'01'.repeat(32)}\t0x${Buffer.from(pub).toString('hex')}\tok`;
}
function createWorker() {
  const worker = new Worker(new URL('./browser-worker-adapter.mjs', import.meta.url));
  const wrapper = { postMessage: (data) => worker.postMessage(data), terminate: () => worker.terminate() };
  worker.on('message', (data) => wrapper.onmessage?.({ data }));
  worker.on('error', (error) => wrapper.onerror?.(error));
  return wrapper;
}
function run(text, options = {}) {
  return new Promise((resolve) => {
    let pool;
    pool = createPublicKeySearchPool({ createWorker, text, lower: '1', upper: '20', cores: 3,
      onUpdate: options.onUpdate ? (progress) => options.onUpdate(progress, pool) : () => {},
      onFinish: resolve, ...options.config });
    pool.start();
    options.afterStart?.(pool);
  });
}

test('partitions targets without gaps or duplicates', () => {
  const groups = partitionTargets([1,2,3,4,5,6,7], 3);
  assert.deepEqual(groups.flatMap((group) => group.targets), [1,2,3,4,5,6,7]);
  assert.deepEqual(groups.map((g) => g.offset), [0,3,6]);
});
test('parallel workers combine all matches, totals and original target indexes', async () => {
  const { result, error } = await run([header, row(1), row(21), row(5), row(10), row(20)].join('\n'));
  assert.equal(error, undefined); assert.equal(result.status, 'done');
  assert.equal(result.workers, 3); assert.equal(result.targetCount, 5);
  assert.equal(result.total, estimateSearchWork(20n, 5)); assert.equal(result.completed, result.total);
  assert.deepEqual(result.matches.map((m) => [m.index, m.scalar]).sort((a,b) => a[0]-b[0]), [[0,'1'],[2,'5'],[3,'10'],[4,'20']]);
});
test('invalid file fails before any search starts', async () => {
  const { error, result } = await run(`${header}\ninvalid`);
  assert.match(error, /Line 2/); assert.equal(result, undefined);
});
test('cancellation during validation is reported as partial', async () => {
  const { result } = await run([header, row(1)].join('\n'), { afterStart: (pool) => pool.cancel() });
  assert.equal(result.status, 'cancelled'); assert.equal(result.completed, 0n);
});
test('cancellation of the worker pool returns partial results', async () => {
  const text = [header, ...Array.from({ length: 24 }, (_, i) => row(i + 1000001))].join('\n');
  let requested = false;
  const { result } = await run(text, {
    config: { upper: '10000000', cores: 3 },
    onUpdate: (progress, pool) => { if (progress.completed > 0n && !requested) { requested = true; pool.cancel(); } },
  });
  assert.ok(requested); assert.equal(result.status, 'cancelled'); assert.ok(result.completed < result.total);
});
