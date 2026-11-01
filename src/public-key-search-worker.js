import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createWebGpuLookup } from './webgpu-lookup.js';
import { createGpuBridgeClient } from './webgpu-bridge.js';
import { parsePublicKeyFile, searchPublicKeys, validatePointSearchRange } from './public-key-search.js';

let stopped = false;
const gpuBridge = createGpuBridgeClient((message) => self.postMessage(message));
self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { stopped = true; return; }
  if (data.type === 'gpu-response') { gpuBridge.handle(data); return; }
  try {
    if (data.type === 'validate') {
      validatePointSearchRange(data.lower, data.upper);
      const targets = parsePublicKeyFile(data.text).map(({ address, publicKey, transactionHash }) => ({ address, publicKey, transactionHash }));
      self.postMessage({ type: 'validated', targets });
    } else if (data.type === 'start') {
      stopped = false;
      const range = validatePointSearchRange(data.lower, data.upper);
      // Targets were validated in the validation worker. Recreate points after
      // structured cloning, which does not preserve point prototypes.
      const targets = data.targets.map((target) => ({ ...target, point: secp256k1.Point.fromBytes(Uint8Array.from(target.publicKey.slice(2).match(/../g), (byte) => parseInt(byte, 16))) }));
      let gpuLookup = null;
      try {
        if (data.backend === 'webgpu-high' || data.backend === 'webgpu-low') {
          const preference = data.backend === 'webgpu-low' ? 'low-power' : 'high-performance';
          gpuLookup = globalThis.navigator?.gpu ? await createWebGpuLookup(preference) : await gpuBridge.create(preference);
        }
        const result = await searchPublicKeys(targets, range, {
          gpuLookup, shouldStop: () => stopped,
          onProgress: (progress) => self.postMessage({ type: 'progress', ...progress }),
        });
        self.postMessage({ type: 'result', ...result });
      } finally { gpuLookup?.destroy(); }
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message ?? String(error) });
  }
};
