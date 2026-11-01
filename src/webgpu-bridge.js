import { createWebGpuLookup, pointWords } from './webgpu-lookup.js';

// Some browsers expose WebGPU on Window but not in workers. In that case,
// workers keep curve math local and ask Window to perform GPU lookup batches.
export function createGpuBridgeHost(worker, createLookup = createWebGpuLookup) {
  let closed = false;
  let gpu = null;
  let nextTable = 1;
  const tables = new Map();
  const reply = (id, data) => {
    if (!closed && id) worker.postMessage({ type: 'gpu-response', id, ...data });
  };
  return {
    async handle(message) {
      if (closed) return;
      const { id, operation } = message;
      try {
        let value;
        if (operation === 'init') {
          const created = await createLookup(message.preference);
          if (closed) { created.destroy(); return; }
          gpu = created;
          value = created.adapterInfo ?? {};
        } else if (operation === 'prepare') {
          if (!gpu) throw new Error('WebGPU bridge is not initialized.');
          const table = await gpu.prepare(message.points);
          if (closed) { table.destroy(); return; }
          value = nextTable++;
          tables.set(value, table);
        } else if (operation === 'lookup') {
          const table = tables.get(message.tableId);
          if (!table) throw new Error('WebGPU bridge table is unavailable.');
          value = await table.lookup(message.points);
        } else if (operation === 'destroy-table') {
          tables.get(message.tableId)?.destroy();
          tables.delete(message.tableId);
        } else if (operation === 'destroy') {
          tables.forEach((table) => table.destroy()); tables.clear();
          gpu?.destroy(); gpu = null;
        } else throw new Error('Unknown WebGPU bridge request.');
        reply(id, { value });
      } catch (error) {
        reply(id, { error: error?.message ?? String(error) });
      }
    },
    close() {
      if (closed) return;
      closed = true;
      tables.forEach((table) => table.destroy()); tables.clear();
      gpu?.destroy(); gpu = null;
    },
  };
}

export function createGpuBridgeClient(send) {
  let nextId = 1;
  const pending = new Map();
  function request(operation, data = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { send({ type: 'gpu-request', id, operation, ...data }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  return {
    handle(message) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.value);
    },
    async create(preference) {
      const adapterInfo = await request('init', { preference });
      return {
        adapterInfo,
        async prepare(points) {
          const tableId = await request('prepare', { points: points.map(pointWords) });
          return {
            lookup: (points) => request('lookup', { tableId, points: points.map(pointWords) }),
            destroy: () => send({ type: 'gpu-request', operation: 'destroy-table', tableId }),
          };
        },
        destroy: () => send({ type: 'gpu-request', operation: 'destroy' }),
      };
    },
  };
}
