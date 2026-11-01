import { parentPort } from 'node:worker_threads';
globalThis.self = { postMessage: (message) => parentPort.postMessage(message) };
await import('../src/public-key-search-worker.js');
parentPort.on('message', (data) => self.onmessage({ data }));
