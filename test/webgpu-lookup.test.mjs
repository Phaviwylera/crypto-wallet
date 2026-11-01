import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { pointWords, buildGpuTable, createWebGpuLookup } from '../src/webgpu-lookup.js';
import { searchPublicKeys, validatePointSearchRange } from '../src/public-key-search.js';

const Point = secp256k1.Point;
// Software emulator for the WebGPU command interface. This tests buffer layout,
// host-side dispatch and result handling, not actual shader execution or hardware.
function fakeGpu() {
  let usedPreference, dispatched = 0, destroyed = 0, allocated = 0;
  class Buffer {
    constructor(size) { this.data = new Uint32Array(size / 4); }
    async mapAsync() {}
    getMappedRange() { return this.data.buffer; }
    unmap() {}
    destroy() { destroyed++; }
  }
  const device = {
    lost: new Promise(() => {}),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: ({ size }) => { allocated++; return new Buffer(size); },
    createBindGroup: ({ entries }) => entries.map((e) => e.resource.buffer),
    createCommandEncoder: () => {
      let buffers, output, dest;
      return { beginComputePass: () => ({ setPipeline() {}, setBindGroup: (_, b) => { buffers = b; }, dispatchWorkgroups: () => { dispatched++; }, end() {} }),
        copyBufferToBuffer: (source, _, target) => { output = source; dest = target; },
        finish: () => ({ buffers, output, dest }) };
    },
    queue: {
      writeBuffer: (buffer, offset, data) => buffer.data.set(data, offset / 4),
      submit: ([{ buffers, output, dest }]) => {
        const [table, query, , params] = buffers.map((b) => b.data);
        for (let i = 0; i < params[0]; i++) {
          output.data[i] = 0;
          let h = 2166136261;
          for (let k = 0; k < 9; k++) h = Math.imul(h ^ query[i * 9 + k], 16777619) >>> 0;
          let slot = h & params[1];
          for (let probe = 0; probe <= params[1]; probe++) {
            const base = slot * 10, value = table[base + 9];
            if (!value) break;
            if (Array.from({ length: 9 }, (_, k) => table[base + k] === query[i * 9 + k]).every(Boolean)) { output.data[i] = value; break; }
            slot = (slot + 1) & params[1];
          }
        }
        dest.data.set(output.data);
      },
    },
    destroy() { destroyed++; },
  };
  return { gpu: { requestAdapter: async ({ powerPreference }) => { usedPreference = powerPreference; return { info: { vendor: 'test-vendor', architecture: 'test-architecture' }, requestDevice: async () => device }; } }, get usedPreference() { return usedPreference; }, get dispatched() { return dispatched; }, get destroyed() { return destroyed; }, get allocated() { return allocated; } };
}

test('WebGPU is explicit about missing support', async () => {
  await assert.rejects(createWebGpuLookup('high-performance', null), /WebGPU is unavailable/);
});
test('full x-coordinate, parity, and infinity are encoded distinctly', () => {
  const base = Point.BASE;
  assert.notDeepEqual(pointWords(base), pointWords(base.negate()));
  assert.equal(pointWords(Point.ZERO)[8], 2);
  assert.ok(buildGpuTable([Point.ZERO, base]).capacity >= 4);
});
test('GPU lookup host code dispatches and search agrees with CPU matches', async () => {
  const emulated = fakeGpu();
  const gpu = await createWebGpuLookup('low-power', emulated.gpu);
  const targets = [2n, 8n, 11n].map((n) => ({ address: String(n), point: Point.BASE.multiply(n) }));
  const range = validatePointSearchRange('1', '10');
  const cpu = await searchPublicKeys(targets, range, { chunkSize: 6n });
  const result = await searchPublicKeys(targets, range, { chunkSize: 6n, gpuLookup: gpu });
  assert.deepEqual(result.matches, cpu.matches);
  assert.equal(result.completed, result.total);
  assert.equal(emulated.usedPreference, 'low-power');
  assert.ok(emulated.dispatched > 0);
  gpu.destroy();
  assert.ok(emulated.destroyed > 0);
});
test('mismatched GPU results stop the search and clean up the table', async () => {
  let destroyed = false;
  const gpu = { prepare: async () => ({ lookup: async (points) => points.map(() => undefined), destroy: () => { destroyed = true; } }) };
  const targets = [{ address: 'x', point: Point.BASE }];
  await assert.rejects(searchPublicKeys(targets, validatePointSearchRange('1', '3'), { gpuLookup: gpu }), /disagreed/);
  assert.equal(destroyed, true);
});

test('worker bridge routes lookups to a window GPU and cleans up', async () => {
  const { createGpuBridgeHost, createGpuBridgeClient } = await import('../src/webgpu-bridge.js');
  const emulated = fakeGpu();
  let host, client;
  const mainSide = { postMessage: (message) => queueMicrotask(() => client.handle(message)) };
  host = createGpuBridgeHost(mainSide, (preference) => createWebGpuLookup(preference, emulated.gpu));
  client = createGpuBridgeClient((message) => queueMicrotask(() => host.handle(message)));
  const gpu = await client.create('low-power');
  const targets = [2n, 8n, 11n].map((n) => ({ address: String(n), point: Point.BASE.multiply(n) }));
  const range = validatePointSearchRange('1', '10');
  const expected = await searchPublicKeys(targets, range, { chunkSize: 6n });
  const result = await searchPublicKeys(targets, range, { chunkSize: 6n, gpuLookup: gpu });
  assert.deepEqual(result.matches, expected.matches);
  assert.equal(result.status, 'done');
  assert.equal(emulated.usedPreference, 'low-power');
  assert.ok(emulated.dispatched > 0);
  gpu.destroy();
  await new Promise((resolve) => setTimeout(resolve, 0));
  host.close();
  assert.ok(emulated.destroyed > 0);
});

test('worker bridge propagates unavailable WebGPU rather than silently falling back', async () => {
  const { createGpuBridgeHost, createGpuBridgeClient } = await import('../src/webgpu-bridge.js');
  let host, client;
  host = createGpuBridgeHost({ postMessage: (message) => queueMicrotask(() => client.handle(message)) }, async () => { throw new Error('WebGPU unavailable on window'); });
  client = createGpuBridgeClient((message) => queueMicrotask(() => host.handle(message)));
  await assert.rejects(client.create('high-performance'), /unavailable on window/);
  host.close();
});

test('closing the bridge while adapter is pending destroys the device', async () => {
  const { createGpuBridgeHost } = await import('../src/webgpu-bridge.js');
  let resolveDevice, destroyed = false, replied = false;
  const host = createGpuBridgeHost({ postMessage: () => { replied = true; } }, () => new Promise((resolve) => { resolveDevice = resolve; }));
  const task = host.handle({ operation: 'init', id: 1, preference: 'low-power' });
  host.close(); resolveDevice({ destroy: () => { destroyed = true; } });
  await task;
  assert.equal(destroyed, true); assert.equal(replied, false);
});

test('worker without navigator.gpu completes using window bridge', async () => {
  const { Worker } = await import('node:worker_threads');
  const { keccak_256 } = await import('@noble/hashes/sha3.js');
  const { createGpuBridgeHost } = await import('../src/webgpu-bridge.js');
  const { createPublicKeySearchPool } = await import('../src/public-key-search-pool.js');
  const emulated = fakeGpu();
  const header = 'address\ttransaction_hash\tpublic_key_uncompressed\tstatus';
  const rows = [2n, 8n, 11n].map((n) => {
    const pub = Point.BASE.multiply(n).toBytes(false);
    return `0x${Buffer.from(keccak_256(pub.slice(1)).slice(12)).toString('hex')}\t0x${'01'.repeat(32)}\t0x${Buffer.from(pub).toString('hex')}\tok`;
  });
  const createWorker = () => {
    const thread = new Worker(new URL('./browser-worker-adapter.mjs', import.meta.url));
    const worker = { postMessage: (data) => thread.postMessage(data), terminate: () => thread.terminate() };
    thread.on('message', (data) => worker.onmessage?.({ data }));
    thread.on('error', (error) => worker.onerror?.(error));
    return worker;
  };
  const { result, error } = await new Promise((resolve) => {
    const pool = createPublicKeySearchPool({ createWorker, text: [header, ...rows].join('\n'), lower: '1', upper: '10', backend: 'webgpu-low', requestedWorkers: 1, cores: 1,
      createGpuHost: (worker) => createGpuBridgeHost(worker, (preference) => createWebGpuLookup(preference, emulated.gpu)), onUpdate: () => {}, onFinish: resolve });
    pool.start();
  });
  assert.equal(error, undefined);
  assert.equal(result.status, 'done');
  assert.deepEqual(result.matches.map((match) => match.scalar).sort(), ['2', '8']);
  assert.equal(result.completed, result.total);
  assert.ok(emulated.dispatched > 0);
});


test('reused GPU buffers produce correct smaller results and grow only when necessary', async () => {
  const emulated = fakeGpu();
  const gpu = await createWebGpuLookup('low-power', emulated.gpu);
  const table = await gpu.prepare([Point.ZERO, Point.BASE]);
  assert.deepEqual(await table.lookup([Point.BASE, Point.ZERO]), [1, 0]);
  const firstAllocation = emulated.allocated;
  assert.deepEqual(await table.lookup([Point.BASE.multiply(3n)]), [undefined]);
  assert.equal(emulated.allocated, firstAllocation);
  assert.deepEqual(await table.lookup([Point.ZERO, Point.BASE, Point.BASE.multiply(3n)]), [0, 1, undefined]);
  assert.equal(emulated.allocated, firstAllocation + 4);
  table.destroy(); gpu.destroy();
});

test('GPU searches batch up to 1024 keys and verify all GPU results', async () => {
  const counts = [];
  const gpuLookup = { prepare: async () => ({
    lookup: async (points) => { counts.push(points.length); return points.map(() => undefined); },
    destroy() {},
  }) };
  const targets = Array.from({ length: 300 }, (_, i) => ({ address: String(i), point: Point.BASE.multiply(BigInt(i + 100)) }));
  const result = await searchPublicKeys(targets, validatePointSearchRange('1', '1'), { gpuLookup });
  assert.equal(result.status, 'done');
  assert.equal(result.completed, result.total);
  assert.deepEqual(counts, [300]);
});


test('synthetic GPU benchmark verifies warm-up and measurements', async () => {
  const { benchmarkGpuLookup } = await import('../src/gpu-benchmark.js');
  const emulated = fakeGpu();
  const gpu = await createWebGpuLookup('low-power', emulated.gpu);
  const updates = [];
  const result = await benchmarkGpuLookup(gpu, { batchSize: 32, rounds: 3, onProgress: (value) => updates.push(value.completedRounds) });
  assert.equal(result.status, 'done'); assert.equal(result.verified, true);
  assert.equal(result.lookups, 96); assert.ok(result.lookupsPerSecond > 0);
  assert.equal(emulated.dispatched, 4); // Includes the excluded warm-up.
  assert.equal(gpu.adapterInfo.vendor, 'test-vendor');
  assert.deepEqual(updates, [1, 2, 3]);
  gpu.destroy();
});

test('GPU benchmark handles cancellation and mismatch without a throughput result', async () => {
  const { benchmarkGpuLookup } = await import('../src/gpu-benchmark.js');
  let destroyed = false, cancelled = false;
  const gpu = { prepare: async () => ({
    lookup: async (points) => points.map((_, i) => i % 2 === 0 ? i : undefined),
    destroy: () => { destroyed = true; },
  }) };
  const result = await benchmarkGpuLookup(gpu, { batchSize: 16, rounds: 5, shouldStop: () => cancelled, onProgress: () => { cancelled = true; } });
  assert.equal(result.status, 'cancelled'); assert.equal(result.completedRounds, 1);
  assert.equal(result.lookupsPerSecond, undefined); assert.equal(destroyed, true);
  let cleaned = false;
  const wrong = { prepare: async () => ({ lookup: async (points) => points.map(() => undefined), destroy: () => { cleaned = true; } }) };
  await assert.rejects(benchmarkGpuLookup(wrong, { batchSize: 16, rounds: 1 }), /verification failed/);
  assert.equal(cleaned, true);
});

test('GPU benchmark worker uses window bridge when worker WebGPU is unavailable', async () => {
  const { Worker } = await import('node:worker_threads');
  const { createGpuBridgeHost } = await import('../src/webgpu-bridge.js');
  const emulated = fakeGpu();
  const thread = new Worker(new URL('./gpu-benchmark-worker-adapter.mjs', import.meta.url));
  const worker = { postMessage: (data) => thread.postMessage(data), terminate: () => thread.terminate() };
  const host = createGpuBridgeHost(worker, (preference) => createWebGpuLookup(preference, emulated.gpu));
  const result = await new Promise((resolve, reject) => {
    thread.on('error', reject);
    thread.on('message', (data) => {
      if (data.type === 'gpu-request') void host.handle(data);
      if (data.type === 'error') reject(new Error(data.message));
      if (data.type === 'result') resolve(data.result);
    });
    thread.postMessage({ type: 'start', preference: 'low-power' });
  });
  host.close(); await worker.terminate();
  assert.equal(result.status, 'done'); assert.equal(result.path, 'window bridge');
  assert.equal(result.adapter.vendor, 'test-vendor'); assert.equal(result.lookups, 48 * 1024);
  assert.ok(emulated.dispatched > 0);
});
