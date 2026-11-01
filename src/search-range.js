// Inclusive decimal scalar ranges for the educational address search.
export const MAX_SEARCH_SCALAR = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140');

export function parseSearchRange(lower, upper) {
  if (!/^\d+$/.test(lower) || !/^\d+$/.test(upper)) throw new Error('Bounds must be whole decimal numbers.');
  const start = BigInt(lower);
  const end = BigInt(upper);
  if (start < 1n || end > MAX_SEARCH_SCALAR || start > end) {
    throw new Error(`Use 1 ≤ lower ≤ upper ≤ ${MAX_SEARCH_SCALAR.toString()} (secp256k1 order minus one).`);
  }
  return { start, end, count: end - start + 1n };
}

export function partitionSearchRange(start, end, desiredWorkers) {
  const count = end - start + 1n;
  if (count < 1n || !Number.isSafeInteger(desiredWorkers) || desiredWorkers < 1) throw new Error('Invalid search partition.');
  const workers = Number(count < BigInt(desiredWorkers) ? count : BigInt(desiredWorkers));
  const base = count / BigInt(workers);
  const remainder = count % BigInt(workers);
  let next = start;
  return Array.from({ length: workers }, (_, index) => {
    const size = base + (BigInt(index) < remainder ? 1n : 0n);
    const range = { start: next, end: next + size - 1n };
    next += size;
    return range;
  });
}
