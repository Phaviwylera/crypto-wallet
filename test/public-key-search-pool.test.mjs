import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createPublicKeySearchPool, partitionTargets, MAX_PUBLIC_KEY_WORKERS } from '../src/public-key-search-pool.js';
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
  assert.deepEqual(groups.map((g) => g.offset), [0,3,5]);
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

test('manual worker count overrides auto and is capped by targets', async () => {
  const text = [header, row(1), row(2), row(3), row(4), row(5)].join('\n');
  const { result } = await run(text, { config: { cores: 1, requestedWorkers: 4 } });
  assert.equal(result.workers, 4);
  assert.equal(result.completed, result.total);
  const { result: small } = await run(text, { config: { requestedWorkers: 32 } });
  assert.equal(small.workers, 5);
});
test('invalid manual worker counts are rejected before creating workers', async () => {
  for (const requestedWorkers of [0, 33, 1.5, -1]) {
    let created = 0;
    const { error } = await new Promise((resolve) => {
      const pool = createPublicKeySearchPool({ createWorker: () => { created++; }, text: '', lower: '1', upper: '2', cores: 1, requestedWorkers, onUpdate: () => {}, onFinish: resolve });
      pool.start();
    });
    assert.equal(created, 0);
    assert.match(error, new RegExp(`between 1 and ${MAX_PUBLIC_KEY_WORKERS}`));
  }
});

test('WebGPU selection caps workers and reports unavailable hardware without a false completion', async () => {
  const text = [header, row(1), row(2), row(3), row(4)].join('\n');
  let workers = 0;
  const { error, result } = await run(text, {
    config: { backend: 'webgpu-high', cores: 8, requestedWorkers: 8 },
    onUpdate: (progress) => { workers = progress.workers; },
  });
  assert.equal(workers, 2);
  assert.match(error, /WebGPU is unavailable/);
  assert.equal(result, undefined);
});

test('hybrid mode divides keys between CPU and GPU-assisted workers and combines matches', async () => {
  const modes = [];
  const routeWorker = () => {
    const worker = createWorker();
    const send = worker.postMessage;
    worker.postMessage = (data) => {
      if (data.type === 'start') {
        modes.push(data.backend);
        // Exercise real search workers but route the GPU shards to CPU in this
        // hardware-free test; GPU dispatch has separate emulator tests.
        send({ ...data, backend: 'cpu' });
      } else send(data);
    };
    return worker;
  };
  const text = [header, row(1), row(2), row(3), row(4), row(5)].join('\n');
  const { result, error } = await new Promise((resolve) => {
    const pool = createPublicKeySearchPool({ createWorker: routeWorker, text, lower: '1', upper: '20', cores: 4, requestedWorkers: 4, backend: 'hybrid-low', onUpdate: () => {}, onFinish: resolve });
    pool.start();
  });
  assert.equal(error, undefined);
  assert.equal(result.status, 'done');
  assert.equal(result.cpuWorkers, 2); assert.equal(result.gpuWorkers, 2);
  assert.deepEqual(modes.sort(), ['cpu', 'cpu', 'webgpu-low', 'webgpu-low']);
  assert.deepEqual(result.matches.map((match) => match.index).sort((a,b) => a-b), [0,1,2,3,4]);
  assert.equal(result.completed, result.total);
});

test('hybrid requires enough workers and keys and does not silently fall back', async () => {
  const text = [header, row(1), row(2)].join('\n');
  const one = await run(text, { config: { backend: 'hybrid-high', requestedWorkers: 1 } });
  assert.match(one.error, /at least 2 workers/);
  const missing = await run(text, { config: { backend: 'hybrid-high', requestedWorkers: 2 } });
  assert.match(missing.error, /WebGPU is unavailable/);
  assert.equal(missing.result, undefined);
});
