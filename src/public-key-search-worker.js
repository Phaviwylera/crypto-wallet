import { parsePublicKeyFile, searchPublicKeys, validatePointSearchRange } from './public-key-search.js';

let stopped = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { stopped = true; return; }
  if (data.type !== 'start') return;
  try {
    stopped = false;
    const range = validatePointSearchRange(data.lower, data.upper);
    const targets = parsePublicKeyFile(data.text);
    self.postMessage({ type: 'validated', count: targets.length });
    const result = await searchPublicKeys(targets, range, {
      shouldStop: () => stopped,
      onProgress: (progress) => self.postMessage({ type: 'progress', ...progress }),
    });
    self.postMessage({ type: 'result', ...result, targetCount: targets.length, lower: range.start.toString(), upper: range.end.toString() });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message ?? String(error) });
  }
};
