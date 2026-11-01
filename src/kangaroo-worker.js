import { runPollardKangarooDemo } from './pollard-kangaroo-demo.js';

self.onmessage = () => {
  try {
    self.postMessage({ result: runPollardKangarooDemo() });
  } catch (error) {
    self.postMessage({ error: error?.message ?? String(error) });
  }
};
