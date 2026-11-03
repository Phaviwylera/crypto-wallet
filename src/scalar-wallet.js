import { parseSearchRange } from './search-range.js';

export function parseScalarBatchRange(lower, upper) {
  // No artificial row cap: callers are responsible for choosing suitable storage.
  // The mathematical secp256k1 scalar bounds are still enforced.
  return parseSearchRange(lower, upper);
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
