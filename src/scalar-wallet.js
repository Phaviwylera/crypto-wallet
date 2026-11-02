import { parseSearchRange } from './search-range.js';

export const MAX_SCALAR_BATCH_SIZE = 10_000;

export function parseScalarBatchRange(lower, upper) {
  const range = parseSearchRange(lower, upper);
  if (range.count > BigInt(MAX_SCALAR_BATCH_SIZE)) {
    throw new Error(`Generate at most ${MAX_SCALAR_BATCH_SIZE.toLocaleString('en-US')} scalars at once; choose a smaller inclusive interval.`);
  }
  return range;
}

export function scalarBatchRow(address, publicKey) {
  if (typeof address !== 'string' || !address || typeof publicKey !== 'string' || !publicKey) {
    throw new Error('Derivation did not return an address and public key.');
  }
  // Headerless TSV: address first, uncompressed public key second.
  return `${address}\t${publicKey}\n`;
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
    rows.push(scalarBatchRow(derived.address, derived.publicKey));

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
