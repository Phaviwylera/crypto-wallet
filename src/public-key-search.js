import { secp256k1 } from '@noble/curves/secp256k1.js';
import { normalizeZ } from '@noble/curves/abstract/curve.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { parseSearchRange, MAX_SEARCH_SCALAR } from './search-range.js';

const Point = secp256k1.Point;
export const MAX_PRIVATE_SCALAR = MAX_SEARCH_SCALAR;
export const SEARCH_CHUNK_SIZE = 100_000_000n;
export const MAX_TARGETS = 10_000;

// The public-key extraction export is tab separated, with an optional header.
// Reject incorrect rows instead of silently claiming they were searched.
export function parsePublicKeyFile(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const targets = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const cols = line.split('\t').map((value) => value.trim());
    if (index === 0 && cols[0].toLowerCase() === 'address') continue;
    const [address, transactionHash, publicKey, status] = cols;
    if (cols.length !== 4 || !/^0x[0-9a-f]{40}$/i.test(address) || !/^0x[0-9a-f]{64}$/i.test(transactionHash) || !/^0x04[0-9a-f]{128}$/i.test(publicKey) || status?.toLowerCase() !== 'ok') {
      throw new Error(`Line ${index + 1}: expected address, transaction_hash, uncompressed public key, and status ok, separated by tabs.`);
    }
    let point;
    try { point = Point.fromBytes(Uint8Array.from(publicKey.slice(2).match(/../g), (part) => parseInt(part, 16))); }
    catch { throw new Error(`Line ${index + 1}: invalid secp256k1 public key.`); }
    const derived = bytesToHex(keccak_256(point.toBytes(false).slice(1)).slice(12));
    if (derived !== address.slice(2).toLowerCase()) throw new Error(`Line ${index + 1}: public key does not match address.`);
    targets.push({ address, transactionHash, publicKey, point });
    if (targets.length > MAX_TARGETS) throw new Error(`Maximum ${MAX_TARGETS.toLocaleString()} rows per file.`);
  }
  if (!targets.length) throw new Error('No public-key rows found.');
  return targets;
}

export function validatePointSearchRange(lower, upper) {
  return parseSearchRange(lower, upper);
}

// Batch-normalized points expose affine coordinates without another inversion.
// Prefix with parity to distinguish both points having the same x coordinate.
function key(point) {
  if (point.is0()) return 'infinity';
  const { x, y } = point.toAffine();
  return `${y & 1n}:${x.toString(16)}`;
}
const yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0));

// Multi-target BSGS: a shared baby table, and batch-normalized giant steps.
// Every match is checked independently against the original public point.
async function searchChunk(targets, range, { onProgress, shouldStop, batchSize }) {
  const m = Math.ceil(Math.sqrt(Number(range.count)));
  const baby = new Map();
  let p = Point.ZERO;
  const points = [];
  for (let i = 0; i < m; i++) { points.push(p); p = p.add(Point.BASE); }
  normalizeZ(Point, points).forEach((point, i) => baby.set(key(point), i));
  const lowerPoint = Point.BASE.multiply(range.start);
  const giantStep = Point.BASE.multiply(BigInt(m)).negate();
  const giantCount = Math.ceil(Number(range.count) / m);
  const current = targets.map(({ point }) => point.add(lowerPoint.negate()));
  const matches = [];
  let completed = 0;
  const total = targets.length * giantCount;
  const started = performance.now();
  let lastYield = started;
  let lastReport = -Infinity;
  for (let j = 0; j < giantCount; j++) {
    for (let begin = 0; begin < targets.length; begin += batchSize) {
      if (shouldStop()) return { status: 'cancelled', completed, total, matches, elapsedMs: performance.now() - started };
      const end = Math.min(begin + batchSize, targets.length);
      const indices = [];
      for (let i = begin; i < end; i++) if (current[i] !== null) indices.push(i);
      const normalized = normalizeZ(Point, indices.map((i) => current[i]));
      for (let n = 0; n < indices.length; n++) {
        const i = indices[n];
        const collisionPoint = key(normalized[n]);
        const babyIndex = baby.get(collisionPoint);
        const offset = BigInt(j * m + (babyIndex ?? 0));
        if (babyIndex !== undefined && offset < range.count) {
          const scalar = range.start + offset;
          if (Point.BASE.multiply(scalar).equals(targets[i].point)) {
            matches.push({ index: i, address: targets[i].address, scalar: scalar.toString(), collisionPoint: collisionPoint === 'infinity' ? 'point at infinity' : `0x${bytesToHex(normalized[n].toBytes(true))}`, babyStep: babyIndex, giantStep: j });
            current[i] = null;
            continue;
          }
        }
        current[i] = current[i].add(giantStep);
      }
      completed += end - begin;
      const now = performance.now();
      if (now - lastReport >= 100 || completed === total) {
        onProgress({ completed, total, matches: matches.length, elapsedMs: now - started });
        lastReport = now;
      }
      // Yield periodically rather than once per batch. This avoids thousands of
      // timer-clamp delays while still processing cancellation requests promptly.
      if (now - lastYield >= 12) {
        await yieldTask();
        lastYield = performance.now();
      }
    }
  }
  return { status: 'done', completed, total, matches, elapsedMs: performance.now() - started };
}

export function estimateSearchWork(count, targetCount, chunkSize = SEARCH_CHUNK_SIZE) {
  if (count < 1n || chunkSize < 1n || chunkSize > SEARCH_CHUNK_SIZE || !Number.isSafeInteger(targetCount) || targetCount < 0) throw new Error('Invalid search work.');
  const workFor = (size) => {
    const m = Math.ceil(Math.sqrt(Number(size)));
    return BigInt(Math.ceil(Number(size) / m)) * BigInt(targetCount);
  };
  const fullChunks = count / chunkSize;
  const remainder = count % chunkSize;
  return fullChunks * workFor(chunkSize) + (remainder ? workFor(remainder) : 0n);
}

// Split arbitrary valid intervals into memory-bounded BSGS searches. This is
// sequential and does not make a large or full-keyspace search practical.
export async function searchPublicKeys(targets, range, { onProgress = () => {}, shouldStop = () => false, batchSize = 128, chunkSize = SEARCH_CHUNK_SIZE } = {}) {
  if (chunkSize < 1n || chunkSize > SEARCH_CHUNK_SIZE) throw new Error('Invalid chunk size.');
  const chunkCount = (range.count + chunkSize - 1n) / chunkSize;
  const total = estimateSearchWork(range.count, targets.length, chunkSize);
  const started = performance.now();
  let completed = 0n;
  let completedChunks = 0n;
  const matches = [];
  let next = range.start;
  while (next <= range.end) {
    if (shouldStop()) return { status: 'cancelled', completed, total, completedChunks, chunkCount, matches, elapsedMs: performance.now() - started };
    const end = next + chunkSize - 1n < range.end ? next + chunkSize - 1n : range.end;
    const chunkRange = { start: next, end, count: end - next + 1n };
    const chunk = await searchChunk(targets, chunkRange, {
      batchSize, shouldStop,
      onProgress: (progress) => onProgress({
        completed: completed + BigInt(progress.completed), total,
        matches: matches.length + progress.matches, completedChunks, chunkCount,
        chunkStart: next.toString(), chunkEnd: end.toString(),
        elapsedMs: performance.now() - started,
      }),
    });
    completed += BigInt(chunk.completed);
    matches.push(...chunk.matches);
    if (chunk.status === 'cancelled') return { status: 'cancelled', completed, total, completedChunks, chunkCount, matches, elapsedMs: performance.now() - started };
    completedChunks += 1n;
    next = end + 1n;
  }
  return { status: 'done', completed, total, completedChunks, chunkCount, matches, elapsedMs: performance.now() - started };
}
