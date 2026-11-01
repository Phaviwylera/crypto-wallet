import { benchmarkGpuLookup } from './gpu-benchmark.js';
import { createWebGpuLookup } from './webgpu-lookup.js';
import { createGpuBridgeClient } from './webgpu-bridge.js';

let stopped = false;
const bridge = createGpuBridgeClient((message) => self.postMessage(message));
self.onmessage = async ({ data }) => {
  if (data.type === 'gpu-response') { bridge.handle(data); return; }
  if (data.type === 'cancel') { stopped = true; return; }
  if (data.type !== 'start') return;
  let gpu;
  try {
    stopped = false;
    const path = globalThis.navigator?.gpu ? 'worker' : 'window bridge';
    gpu = path === 'worker' ? await createWebGpuLookup(data.preference) : await bridge.create(data.preference);
    const result = await benchmarkGpuLookup(gpu, {
      shouldStop: () => stopped,
      onProgress: (progress) => self.postMessage({ type: 'progress', ...progress }),
    });
    self.postMessage({ type: 'result', result: { ...result, preference: data.preference, adapter: gpu.adapterInfo ?? {}, path } });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message ?? String(error) });
  } finally { gpu?.destroy(); }
};
