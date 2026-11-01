// WebGPU assists BSGS table lookup only. ECC arithmetic remains on the CPU.
// Keys contain all 256 x bits plus y parity (or an infinity marker).
const WORDS = 9;
const ENTRY_WORDS = 10;
const STORAGE = 0x80, COPY_SRC = 0x04, COPY_DST = 0x08, MAP_READ = 0x01;

export function pointWords(point) {
  if (point instanceof Uint32Array && point.length === WORDS) return point;
  const words = new Uint32Array(WORDS);
  if (point.is0()) { words[8] = 2; return words; }
  let { x, y } = point.toAffine();
  for (let i = 0; i < 8; i++) { words[i] = Number(x & 0xffffffffn); x >>= 32n; }
  words[8] = Number(y & 1n);
  return words;
}

function hashWords(words) {
  let hash = 2166136261;
  for (let i = 0; i < WORDS; i++) hash = Math.imul(hash ^ words[i], 16777619) >>> 0;
  return hash;
}

export function buildGpuTable(points) {
  let capacity = 2;
  while (capacity < points.length * 2) capacity *= 2;
  const table = new Uint32Array(capacity * ENTRY_WORDS);
  points.forEach((point, index) => {
    const words = pointWords(point);
    let slot = hashWords(words) & (capacity - 1);
    while (table[slot * ENTRY_WORDS + WORDS] !== 0) slot = (slot + 1) & (capacity - 1);
    table.set(words, slot * ENTRY_WORDS);
    table[slot * ENTRY_WORDS + WORDS] = index + 1;
  });
  return { table, capacity };
}

const SHADER = `
@group(0) @binding(0) var<storage, read> table: array<u32>;
@group(0) @binding(1) var<storage, read> queries: array<u32>;
@group(0) @binding(2) var<storage, read_write> results: array<u32>;
@group(0) @binding(3) var<storage, read> params: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params[0]) { return; }
  let q = i * 9u;
  var h = 2166136261u;
  for (var k = 0u; k < 9u; k = k + 1u) { h = (h ^ queries[q + k]) * 16777619u; }
  var slot = h & params[1];
  for (var probe = 0u; probe <= params[1]; probe = probe + 1u) {
    let base = slot * 10u;
    let found = table[base + 9u];
    if (found == 0u) { results[i] = 0u; return; }
    var same = true;
    for (var k = 0u; k < 9u; k = k + 1u) { if (table[base + k] != queries[q + k]) { same = false; } }
    if (same) { results[i] = found; return; }
    slot = (slot + 1u) & params[1];
  }
  results[i] = 0u;
}`;

export async function createWebGpuLookup(preference = 'high-performance', gpu = globalThis.navigator?.gpu) {
  if (!gpu) throw new Error('WebGPU is unavailable in this browser context. Use HTTPS or localhost, enable WebGPU in a supported browser, or select CPU mode.');
  const adapter = await gpu.requestAdapter({ powerPreference: preference });
  if (!adapter) throw new Error('No compatible WebGPU adapter found. Select CPU mode.');
  const device = await adapter.requestDevice();
  let deviceLost = false;
  device.lost.then(() => { deviceLost = true; });
  try {
    const module = device.createShaderModule({ code: SHADER });
    if (module.getCompilationInfo) {
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((message) => message.type === 'error');
      if (errors.length) throw new Error(`WebGPU shader compilation failed: ${errors[0].message}`);
    }
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    return {
      adapterInfo: Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map((name) => [name, String(adapter.info?.[name] ?? '')])),
      async prepare(points) {
        const { table, capacity } = buildGpuTable(points);
        const tableBuffer = device.createBuffer({ size: table.byteLength, usage: STORAGE | COPY_DST });
        device.queue.writeBuffer(tableBuffer, 0, table);
        let buffers = null;
        let queryCapacity = 0;
        let inFlight = false;
        let destroyed = false;
        const freeBuffers = () => {
          if (!buffers) return;
          buffers.query.destroy(); buffers.result.destroy(); buffers.readback.destroy(); buffers.params.destroy();
          buffers = null; queryCapacity = 0;
        };
        const ensureCapacity = (count) => {
          if (count <= queryCapacity) return;
          freeBuffers();
          const created = [];
          const allocate = (size, usage) => {
            const buffer = device.createBuffer({ size, usage });
            created.push(buffer);
            return buffer;
          };
          try {
            const query = allocate(count * WORDS * 4, STORAGE | COPY_DST);
            const result = allocate(count * 4, STORAGE | COPY_SRC);
            const readback = allocate(count * 4, MAP_READ | COPY_DST);
            const params = allocate(8, STORAGE | COPY_DST);
            const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
              { binding: 0, resource: { buffer: tableBuffer } }, { binding: 1, resource: { buffer: query } },
              { binding: 2, resource: { buffer: result } }, { binding: 3, resource: { buffer: params } },
            ] });
            buffers = { query, result, readback, params, bindGroup };
            queryCapacity = count;
          } catch (error) {
            created.forEach((buffer) => buffer.destroy());
            throw error;
          }
        };
        return {
          async lookup(pointsToCheck) {
            if (destroyed || deviceLost) throw new Error('WebGPU device was lost or closed. Search stopped; retry or choose CPU mode.');
            if (!pointsToCheck.length) return [];
            if (inFlight) throw new Error('Concurrent lookups on the same WebGPU table are not supported.');
            inFlight = true;
            try {
              ensureCapacity(pointsToCheck.length);
              const data = new Uint32Array(pointsToCheck.length * WORDS);
              pointsToCheck.forEach((point, index) => data.set(pointWords(point), index * WORDS));
              const { query, result, readback, params, bindGroup } = buffers;
              device.queue.writeBuffer(query, 0, data);
              device.queue.writeBuffer(params, 0, new Uint32Array([pointsToCheck.length, capacity - 1]));
              const encoder = device.createCommandEncoder();
              const pass = encoder.beginComputePass();
              pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(Math.ceil(pointsToCheck.length / 64)); pass.end();
              encoder.copyBufferToBuffer(result, 0, readback, 0, pointsToCheck.length * 4);
              device.queue.submit([encoder.finish()]);
              await readback.mapAsync(MAP_READ, 0, pointsToCheck.length * 4);
              try {
                return Array.from(new Uint32Array(readback.getMappedRange(0, pointsToCheck.length * 4)).slice(0, pointsToCheck.length), (value) => value ? value - 1 : undefined);
              } finally { readback.unmap(); }
            } finally { inFlight = false; }
          },
          destroy() { if (!destroyed) { destroyed = true; freeBuffers(); tableBuffer.destroy(); } },
        };
      },
      destroy() { device.destroy(); },
    };
  } catch (error) { device.destroy(); throw error; }
}
