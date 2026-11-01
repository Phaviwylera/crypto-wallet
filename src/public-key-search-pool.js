import { createGpuBridgeHost } from './webgpu-bridge.js';
import { estimateSearchWork, validatePointSearchRange } from './public-key-search.js';

export const MAX_PUBLIC_KEY_WORKERS = 32;

export function partitionTargets(targets, workerCount) {
  if (!Number.isSafeInteger(workerCount) || workerCount < 1) throw new Error('Invalid worker count.');
  const count = Math.min(workerCount, targets.length);
  const base = Math.floor(targets.length / count);
  const remainder = targets.length % count;
  let offset = 0;
  return Array.from({ length: count }, (_, index) => {
    const size = base + (index < remainder ? 1 : 0);
    const group = { offset, targets: targets.slice(offset, offset + size) };
    offset += size;
    return group;
  });
}

// The validation worker checks the entire file first, then each search worker
// processes a disjoint group of targets over the same interval. Each has its
// own baby table; aggregate counters are exact BigInts.
export function createPublicKeySearchPool({ createWorker, text, lower, upper, cores, requestedWorkers = null, backend = 'cpu', onUpdate, onFinish, createGpuHost = createGpuBridgeHost, now = () => performance.now() }) {
  let workers = [];
  let gpuHosts = [];
  let cancelled = false;
  let finished = false;
  const started = now();
  let states = [];
  let targetCount = 0;
  let workerCount = 0;
  let cpuWorkers = 0;
  let gpuWorkers = 0;
  let range;
  const cleanup = () => { gpuHosts.forEach((host) => host.close()); gpuHosts = []; workers.forEach((w) => w.terminate()); workers = []; };
  const fail = (message) => { if (finished) return; finished = true; cleanup(); onFinish({ error: message }); };
  const finish = (result) => { if (finished) return; finished = true; cleanup(); onFinish({ result }); };
  const aggregate = () => ({
    completed: states.reduce((sum, s) => sum + s.completed, 0n),
    total: states.reduce((sum, s) => sum + s.total, 0n),
    matches: states.reduce((sum, s) => sum + s.matches, 0),
    elapsedMs: now() - started, workers: workerCount, cpuWorkers, gpuWorkers, backend,
  });
  function start() {
    try {
      range = validatePointSearchRange(lower, upper);
      if (!['cpu', 'webgpu-high', 'webgpu-low', 'hybrid-high', 'hybrid-low'].includes(backend)) throw new Error('Unknown search backend.');
      if (requestedWorkers !== null && (!Number.isSafeInteger(requestedWorkers) || requestedWorkers < 1 || requestedWorkers > MAX_PUBLIC_KEY_WORKERS)) throw new Error(`Choose between 1 and ${MAX_PUBLIC_KEY_WORKERS} CPU workers.`);
      const validator = createWorker(); workers.push(validator);
      validator.onerror = (error) => fail(error.message || 'Validation worker failed.');
      validator.onmessage = ({ data }) => {
        if (finished) return;
        if (data.type === 'error') { fail(data.message); return; }
        if (data.type !== 'validated') return;
        validator.terminate(); workers = [];
        const targets = data.targets;
        targetCount = targets.length;
        const available = Number.isSafeInteger(cores) && cores > 0 ? cores : 2;
        const hybrid = backend.startsWith('hybrid-');
        const gpuOnly = backend.startsWith('webgpu-');
        const count = Math.min(requestedWorkers ?? Math.max(hybrid ? 2 : 1, Math.min(8, available)), gpuOnly ? 2 : MAX_PUBLIC_KEY_WORKERS);
        if (hybrid && (count < 2 || targets.length < 2)) { fail('Hybrid mode requires at least 2 workers and 2 public keys.'); return; }
        const groups = partitionTargets(targets, Math.min(count, targets.length));
        workerCount = groups.length;
        gpuWorkers = hybrid ? Math.min(2, Math.floor(workerCount / 2)) : gpuOnly ? workerCount : 0;
        cpuWorkers = workerCount - gpuWorkers;
        states = groups.map((group) => ({ completed: 0n, total: estimateSearchWork(range.count, group.targets.length), matches: 0, done: false, result: null, offset: group.offset }));
        onUpdate({ ...aggregate(), count: targetCount });
        try {
          groups.forEach((group, index) => {
            const worker = createWorker(); workers.push(worker);
            const gpuHost = index < gpuWorkers ? createGpuHost(worker) : null;
            if (gpuHost) gpuHosts.push(gpuHost);
            worker.onerror = (error) => fail(error.message || 'Search worker failed.');
            worker.onmessage = ({ data }) => {
              if (finished) return;
              const state = states[index];
              if (data.type === 'gpu-request' && gpuHost) { void gpuHost.handle(data); return; }
              if (data.type === 'error') { fail(data.message); return; }
              if (data.type === 'progress') {
                state.completed = data.completed; state.matches = data.matches;
              } else if (data.type === 'result') {
                state.completed = data.completed; state.matches = data.matches.length; state.done = true; state.result = data;
              } else return;
              const current = aggregate();
              onUpdate({ ...current, count: targetCount });
              if (states.every((s) => s.done)) {
                const results = states.flatMap((s) => s.result.matches.map((match) => ({ ...match, index: match.index + s.offset })));
                finish({ ...current, status: states.some((s) => s.result.status === 'cancelled') ? 'cancelled' : 'done', matches: results, targetCount, lower, upper });
              }
            };
            const workerBackend = index < gpuWorkers ? (backend.endsWith('low') ? 'webgpu-low' : 'webgpu-high') : 'cpu';
            worker.postMessage({ type: 'start', targets: group.targets, lower, upper, backend: workerBackend });
          });
        } catch (error) { fail(error?.message ?? String(error)); }
      };
      validator.postMessage({ type: 'validate', text, lower, upper });
    } catch (error) { fail(error?.message ?? String(error)); }
  }
  function cancel() {
    if (finished || cancelled) return;
    cancelled = true;
    if (!states.length) {
      finish({ status: 'cancelled', completed: 0n, total: 0n, matches: [], targetCount: 0, elapsedMs: now() - started, lower, upper, backend, workers: 0 });
    } else workers.forEach((worker) => worker.postMessage({ type: 'cancel' }));
  }
  return { start, cancel };
}
