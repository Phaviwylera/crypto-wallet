import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { pointWords, buildGpuTable, createWebGpuLookup } from '../src/webgpu-lookup.js';
import { searchPublicKeys, validatePointSearchRange } from '../src/public-key-search.js';

const Point = secp256k1.Point;
// Software emulator for the WebGPU command interface. This tests buffer layout,
// host-side dispatch and result handling, not actual shader execution or hardware.
function fakeGpu() {
  let usedPreference, dispatched = 0, destroyed = 0;
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
    createBuffer: ({ size }) => new Buffer(size),
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
  return { gpu: { requestAdapter: async ({ powerPreference }) => { usedPreference = powerPreference; return { requestDevice: async () => device }; } }, get usedPreference() { return usedPreference; }, get dispatched() { return dispatched; }, get destroyed() { return destroyed; } };
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
