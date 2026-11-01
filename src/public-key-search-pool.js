import { estimateSearchWork, validatePointSearchRange } from './public-key-search.js';

export function partitionTargets(targets, workerCount) {
  const size = Math.ceil(targets.length / workerCount);
  return Array.from({ length: Math.ceil(targets.length / size) }, (_, i) => ({ offset: i * size, targets: targets.slice(i * size, (i + 1) * size) }));
}

// The validation worker checks the entire file first, then each search worker
// processes a disjoint group of targets over the same interval. Each has its
// own baby table; aggregate counters are exact BigInts.
export function createPublicKeySearchPool({ createWorker, text, lower, upper, cores, onUpdate, onFinish, now = () => performance.now() }) {
  let workers = [];
  let cancelled = false;
  let finished = false;
  const started = now();
  let states = [];
  let targetCount = 0;
  let workerCount = 0;
  let range;
  const cleanup = () => { workers.forEach((w) => w.terminate()); workers = []; };
  const fail = (message) => { if (finished) return; finished = true; cleanup(); onFinish({ error: message }); };
  const finish = (result) => { if (finished) return; finished = true; cleanup(); onFinish({ result }); };
  const aggregate = () => ({
    completed: states.reduce((sum, s) => sum + s.completed, 0n),
    total: states.reduce((sum, s) => sum + s.total, 0n),
    matches: states.reduce((sum, s) => sum + s.matches, 0),
    elapsedMs: now() - started, workers: workerCount,
  });
  function start() {
    try {
      range = validatePointSearchRange(lower, upper);
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
        const groups = partitionTargets(targets, Math.min(8, available, targets.length));
        workerCount = groups.length;
        states = groups.map((group) => ({ completed: 0n, total: estimateSearchWork(range.count, group.targets.length), matches: 0, done: false, result: null, offset: group.offset }));
        onUpdate({ ...aggregate(), count: targetCount });
        try {
          groups.forEach((group, index) => {
            const worker = createWorker(); workers.push(worker);
            worker.onerror = (error) => fail(error.message || 'Search worker failed.');
            worker.onmessage = ({ data }) => {
              if (finished) return;
              const state = states[index];
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
            worker.postMessage({ type: 'start', targets: group.targets, lower, upper });
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
      finish({ status: 'cancelled', completed: 0n, total: 0n, matches: [], targetCount: 0, elapsedMs: now() - started, lower, upper });
    } else workers.forEach((worker) => worker.postMessage({ type: 'cancel' }));
  }
  return { start, cancel };
}
