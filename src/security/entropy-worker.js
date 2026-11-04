import { analyzeEntropy } from './entropy-core.mjs';
self.onmessage = async ({ data }) => {
  try {
    const result = await analyzeEntropy(new Uint8Array(data.buffer), { label: data.label, format: data.format });
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: error?.message ?? String(error) });
  }
};
