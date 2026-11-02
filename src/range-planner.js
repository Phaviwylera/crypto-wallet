import { MAX_SEARCH_SCALAR, parseSearchRange } from './search-range.js';
import { estimateSearchWork, SEARCH_CHUNK_SIZE } from './public-key-search.js';

// Conditional range, not an inference about a public key.
export function rangeForBitLength(input) {
  if (!/^\d+$/.test(input)) throw new Error('Enter a bit length from 1 to 256.');
  const bits = Number(input);
  if (!Number.isInteger(bits) || bits < 1 || bits > 256) throw new Error('Enter a bit length from 1 to 256.');
  const start = 1n << BigInt(bits - 1);
  const end = (1n << BigInt(bits)) - 1n;
  return { start, end: end < MAX_SEARCH_SCALAR ? end : MAX_SEARCH_SCALAR };
}

export function planRange(lower, upper, targetInput, rateInput = '') {
  const range = parseSearchRange(lower, upper);
  if (!/^\d+$/.test(targetInput) || Number(targetInput) < 1 || Number(targetInput) > 10000) throw new Error('Enter an estimated target count from 1 to 10,000.');
  const targets = Number(targetInput);
  const rate = rateInput.trim() === '' ? null : Number(rateInput);
  if (rate !== null && (!Number.isFinite(rate) || rate <= 0)) throw new Error('Enter a positive measured giant-step slots/second rate.');
  const work = estimateSearchWork(range.count, targets);
  return {
    ...range, targets, work,
    chunks: (range.count + SEARCH_CHUNK_SIZE - 1n) / SEARCH_CHUNK_SIZE,
    fraction: Number(range.count) / Number(MAX_SEARCH_SCALAR),
    seconds: rate === null ? null : Number(work) / rate,
  };
}
