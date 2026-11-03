import { parseSearchRange } from './search-range.js';

export function parseScalarBatchRange(lower, upper) {
  // No artificial row cap: callers are responsible for choosing suitable storage.
  // The mathematical secp256k1 scalar bounds are still enforced.
  return parseSearchRange(lower, upper);
}

export function parseScalarSampleCount(value, rangeCount) {
  if (!/^\d+$/.test(value)) throw new Error('Random sample count must be a whole decimal number.');
  const count = BigInt(value);
  if (count < 1n) throw new Error('Random sample count must be at least 1.');
  if (count > rangeCount) throw new Error('Random sample count cannot exceed the inclusive range size.');
  return count;
}

function randomBigIntBelow(bound) {
  if (bound <= 0n) throw new Error('Random bound must be positive.');
  const bits = bound.toString(2).length;
  const byteLength = Math.ceil(bits / 8);
  const mask = (1n << BigInt(bits)) - 1n;
  const bytes = new Uint8Array(byteLength);
  while (true) {
    globalThis.crypto.getRandomValues(bytes);
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    value &= mask;
    if (value < bound) return value;
  }
}

export async function sampleScalarOffsets({
  rangeCount,
  sampleCount,
  shouldCancel = () => false,
  yieldEvery = 1000,
}) {
  const sample = parseScalarSampleCount(String(sampleCount), rangeCount);
  if (!Number.isSafeInteger(Number(sample))) throw new Error('Random sample count is too large for the browser generator.');
  const total = Number(sample);
  const offsets = [];
  const seen = new Set();
  let j = rangeCount - sample;
  for (let i = 0; i < total; i += 1) {
    if (shouldCancel()) {
      const error = new Error('Generation cancelled; no TXT was created.');
      error.name = 'AbortError';
      throw error;
    }
    const random = randomBigIntBelow(j + 1n);
    const chosen = seen.has(random) ? j : random;
    seen.add(chosen);
    offsets.push(chosen);
    j += 1n;
    if (offsets.length % yieldEvery === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return offsets;
}

export async function generateRandomScalarBatch({
  lower,
  upper,
  sampleCount,
  derive,
  onProgress = () => {},
  shouldCancel = () => false,
  yieldEvery = 25,
}) {
  const range = parseScalarBatchRange(lower, upper);
  if (typeof derive !== 'function') throw new Error('An address derivation function is required.');
  if (!Number.isInteger(yieldEvery) || yieldEvery < 1 || yieldEvery > 1000) throw new Error('Invalid generation chunk size.');
  const offsets = await sampleScalarOffsets({ rangeCount: range.count, sampleCount, shouldCancel });
  const rows = [];
  for (let i = 0; i < offsets.length; i += 1) {
    if (shouldCancel()) {
      const error = new Error('Generation cancelled; no TXT was created.');
      error.name = 'AbortError';
      throw error;
    }
    const derived = derive(range.start + offsets[i]);
    rows.push(scalarBatchRow(derived.address, derived.privateKey));
    if (rows.length % yieldEvery === 0 && i < offsets.length - 1) {
      onProgress(rows.length, offsets.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  if (shouldCancel()) {
    const error = new Error('Generation cancelled; no TXT was created.');
    error.name = 'AbortError';
    throw error;
  }
  onProgress(rows.length, offsets.length);
  return { text: rows.join(''), count: rows.length, range, sampleCount: BigInt(rows.length) };
}

export function scalarBatchRow(address, privateKey) {
  if (typeof address !== 'string' || !address || typeof privateKey !== 'string' || !privateKey) {
    throw new Error('Derivation did not return an address and private key.');
  }
  if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) {
    throw new Error('Private key must be 0x-prefixed 32-byte hexadecimal.');
  }
  // Headerless TSV: address first, sensitive 32-byte private key second.
  return `${address}\t${privateKey}\n`;
}

export async function generateScalarBatch({
  lower,
  upper,
  derive,
  onProgress = () => {},
  shouldCancel = () => false,
  yieldEvery = 25,
}) {
  const range = parseScalarBatchRange(lower, upper);
  if (typeof derive !== 'function') throw new Error('An address derivation function is required.');
  if (!Number.isInteger(yieldEvery) || yieldEvery < 1 || yieldEvery > 1000) throw new Error('Invalid generation chunk size.');

  const rows = [];
  for (let scalar = range.start; scalar <= range.end; scalar += 1n) {
    if (shouldCancel()) {
      const error = new Error('Generation cancelled; no TXT was created.');
      error.name = 'AbortError';
      throw error;
    }
    const derived = derive(scalar);
    rows.push(scalarBatchRow(derived.address, derived.privateKey));

    if (rows.length % yieldEvery === 0 && scalar < range.end) {
      onProgress(rows.length, Number(range.count));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  if (shouldCancel()) {
    const error = new Error('Generation cancelled; no TXT was created.');
    error.name = 'AbortError';
    throw error;
  }
  onProgress(rows.length, Number(range.count));
  return { text: rows.join(''), count: rows.length, range };
}
