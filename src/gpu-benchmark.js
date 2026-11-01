import { secp256k1 } from '@noble/curves/secp256k1.js';
import { normalizeZ } from '@noble/curves/abstract/curve.js';

// Synthetic table and query points only: no uploaded data or wallet material.
// Measures the current GPU lookup path, not GPU arithmetic or search speed.
export async function benchmarkGpuLookup(gpu, { rounds = 48, batchSize = 1024, shouldStop = () => false, onProgress = () => {}, clock = () => performance.now() } = {}) {
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100 || !Number.isSafeInteger(batchSize) || batchSize < 2 || batchSize > 1024) throw new Error('Invalid benchmark workload.');
  const points = [];
  let point = secp256k1.Point.ZERO;
  for (let i = 0; i < batchSize * 2; i++) { points.push(point); point = point.add(secp256k1.Point.BASE); }
  const normalized = normalizeZ(secp256k1.Point, points);
  const babies = normalized.slice(0, batchSize);
  const queries = Array.from({ length: batchSize }, (_, index) => normalized[index % 2 === 0 ? index : batchSize + index]);
  const expected = Array.from({ length: batchSize }, (_, index) => index % 2 === 0 ? index : undefined);
  const table = await gpu.prepare(babies);
  const verify = (hits) => {
    if (hits.length !== expected.length) throw new Error('GPU benchmark verification failed: invalid result length.');
    for (let i = 0; i < expected.length; i++) if (hits[i] !== expected[i]) throw new Error('GPU benchmark verification failed: GPU results did not match CPU expectations.');
  };
  try {
    if (shouldStop()) return { status: 'cancelled', completedRounds: 0, rounds, batchSize };
    verify(await table.lookup(queries)); // Warm-up; excluded from measurements.
    if (shouldStop()) return { status: 'cancelled', completedRounds: 0, rounds, batchSize };
    const started = clock();
    const durations = [];
    for (let i = 0; i < rounds; i++) {
      if (shouldStop()) return { status: 'cancelled', completedRounds: i, rounds, batchSize };
      const before = clock();
      const hits = await table.lookup(queries);
      const after = clock();
      verify(hits);
      durations.push(Math.max(0, after - before));
      onProgress({ completedRounds: i + 1, rounds });
    }
    const elapsedMs = Math.max(clock() - started, 0.01);
    durations.sort((a, b) => a - b);
    return {
      status: 'done', completedRounds: rounds, rounds, batchSize,
      lookups: rounds * batchSize, elapsedMs,
      lookupsPerSecond: rounds * batchSize * 1000 / elapsedMs,
      medianBatchMs: durations[Math.floor((durations.length - 1) / 2)],
      p95BatchMs: durations[Math.ceil(durations.length * 0.95) - 1],
      verified: true,
    };
  } finally { table.destroy(); }
}
