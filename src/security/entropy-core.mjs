/**
 * Offline entropy triage. Accepts raw generator output, never wallet secrets.
 * Statistical signals are not proof of a vulnerability; passing is not proof of safety.
 * This module has no network, storage, address derivation, or key-search capability.
 */
export const ENTROPY_SCHEMA_VERSION = '1.0.0';
export const MIN_ENTROPY_BYTES = 1024;
export const MAX_ENTROPY_BYTES = 8 * 1024 * 1024;
export const RECOMMENDED_ENTROPY_BYTES = 65536;
export const SIGNAL_P_VALUE = 0.001;
export const REVIEW_P_VALUE = 0.01;

const LIMITATIONS = [
  'Tests examine only the supplied bytes, not how they were generated or whether a seed can be predicted.',
  'A cryptographic weakness can produce output that passes every statistical test. Review source, seed provenance, platform fallbacks and build flags.',
  'Empirical Shannon and minimum entropy describe this sample; they are not certified entropy bounds for the generator.',
  'Several tests are run together. Even good generators occasionally produce a small p-value; investigate reproducibility and source before claiming a flaw.',
  'No private keys, addresses, balances, ownership, or third-party wallets are examined.',
];

export function erfc(x) {
  if (!Number.isFinite(x)) return x === Infinity ? 0 : x === -Infinity ? 2 : NaN;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const value = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? value : 2 - value;
}

function logGamma(x) {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.9999999999998099;
  for (let i = 0; i < coefficients.length; i++) a += coefficients[i] / (z + i + 1);
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized upper incomplete gamma Q(a,x), used for chi-square tail probabilities. */
export function gammaQ(a, x) {
  if (!(a > 0) || !(x >= 0)) throw new RangeError('gammaQ requires a > 0 and x >= 0.');
  if (x === 0) return 1;
  const factor = Math.exp(a * Math.log(x) - x - logGamma(a));
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n <= 1000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return Math.max(0, Math.min(1, 1 - sum * factor));
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / (Math.abs(b) < tiny ? tiny : b);
  let h = d;
  for (let i = 1; i <= 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.max(0, Math.min(1, factor * h));
}

export function chiSquarePValue(statistic, degreesOfFreedom) {
  return gammaQ(degreesOfFreedom / 2, statistic / 2);
}

export function monobit(bytes) {
  let ones = 0;
  for (const byte of bytes) {
    let value = byte;
    while (value) { ones += value & 1; value >>>= 1; }
  }
  const bits = bytes.length * 8;
  return { ones, zeros: bits - ones, proportion: ones / bits, pValue: erfc(Math.abs(2 * ones - bits) / Math.sqrt(2 * bits)) };
}

export function runsTest(bytes, proportion) {
  const n = bytes.length * 8;
  if (Math.abs(proportion - 0.5) >= 2 / Math.sqrt(n)) return { runs: null, pValue: null, applicable: false };
  let runs = 1;
  let previous = bytes[0] & 1;
  for (let i = 1; i < n; i++) {
    const bit = (bytes[i >>> 3] >>> (i & 7)) & 1;
    if (bit !== previous) runs++;
    previous = bit;
  }
  const expected = 2 * n * proportion * (1 - proportion) + 1;
  const denominator = 2 * Math.sqrt(2 * n) * proportion * (1 - proportion);
  return { runs, expected, pValue: erfc(Math.abs(runs - expected) / denominator), applicable: true };
}

export function byteStatistics(bytes) {
  const histogram = Array(256).fill(0);
  for (const byte of bytes) histogram[byte]++;
  const expected = bytes.length / 256;
  let chiSquare = 0;
  let shannon = 0;
  let maximumCount = 0;
  let distinct = 0;
  for (const count of histogram) {
    if (!count) continue;
    distinct++;
    maximumCount = Math.max(maximumCount, count);
    chiSquare += (count - expected) ** 2 / expected;
    const p = count / bytes.length;
    shannon -= p * Math.log2(p);
  }
  return { histogram, chiSquare, degreesOfFreedom: 255, pValue: chiSquarePValue(chiSquare, 255), shannonBitsPerByte: shannon === 0 ? 0 : shannon, empiricalMinEntropyBitsPerByte: maximumCount === bytes.length ? 0 : -Math.log2(maximumCount / bytes.length), distinctBytes: distinct };
}

export function serialCorrelation(bytes) {
  const n = bytes.length - 1;
  let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
  for (let i = 0; i < n; i++) {
    const x = bytes[i], y = bytes[i + 1];
    sumX += x; sumY += y; sumXX += x * x; sumYY += y * y; sumXY += x * y;
  }
  const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
  const coefficient = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
  const fisher = Math.max(-0.999999999999, Math.min(0.999999999999, coefficient)) === 0 ? 0 : Math.atanh(Math.max(-0.999999999999, Math.min(0.999999999999, coefficient)));
  return { coefficient, pValue: denominator === 0 ? null : erfc(Math.abs(fisher) * Math.sqrt(Math.max(1, n - 3)) / Math.SQRT2), method: 'Pearson lag-1; Fisher approximation (overlapping pairs)' };
}

export function bitPlanes(bytes) {
  return Array.from({ length: 8 }, (_, plane) => {
    let ones = 0;
    for (const byte of bytes) ones += (byte >>> plane) & 1;
    const n = bytes.length;
    return { plane, ones, proportion: ones / n, pValue: erfc(Math.abs(2 * ones - n) / Math.sqrt(2 * n)) };
  });
}

export function repeatedBlocks(bytes, size) {
  const seen = new Set();
  const completeBlocks = Math.floor(bytes.length / size);
  let duplicates = 0;
  for (let i = 0; i < completeBlocks; i++) {
    let key = '';
    for (let j = 0; j < size; j++) key += bytes[i * size + j].toString(16).padStart(2, '0');
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }
  return { completeBlocks, uniqueBlocks: seen.size, duplicateBlocks: duplicates, duplicateRatio: completeBlocks ? duplicates / completeBlocks : 0 };
}

export function longestBitRun(bytes) {
  let previous = -1, current = 0, longest = 0;
  for (let i = 0; i < bytes.length * 8; i++) {
    const bit = (bytes[i >>> 3] >>> (i & 7)) & 1;
    current = bit === previous ? current + 1 : 1;
    previous = bit;
    if (current > longest) longest = current;
  }
  return longest;
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function defaultCompress(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function pStatus(p, threshold = SIGNAL_P_VALUE) {
  if (p === null || !Number.isFinite(p)) return 'skipped';
  return p < threshold ? 'signal' : p < REVIEW_P_VALUE ? 'review' : 'pass';
}

function check(id, label, status, detail, extra = {}) {
  return { id, label, status, detail, ...extra };
}

/** @returns metadata only; the input bytes are never included in the result. */
export async function analyzeEntropy(input, options = {}) {
  if (!(input instanceof Uint8Array)) throw new TypeError('Entropy input must be a Uint8Array.');
  if (input.length < MIN_ENTROPY_BYTES) throw new RangeError(`Supply at least ${MIN_ENTROPY_BYTES} raw bytes. A single key or recovery phrase is not an audit sample.`);
  if (input.length > MAX_ENTROPY_BYTES) throw new RangeError(`The local audit limit is ${MAX_ENTROPY_BYTES} bytes (8 MiB).`);
  const bytes = input;
  const compress = options.compress ?? defaultCompress;
  const [digest, bitTest, byteStats, compressed] = await Promise.all([
    sha256Hex(bytes), Promise.resolve(monobit(bytes)), Promise.resolve(byteStatistics(bytes)), compress(bytes),
  ]);
  const runs = runsTest(bytes, bitTest.proportion);
  const correlation = serialCorrelation(bytes);
  const planes = bitPlanes(bytes);
  const blocks16 = repeatedBlocks(bytes, 16);
  const blocks32 = repeatedBlocks(bytes, 32);
  const longestRun = longestBitRun(bytes);
  const compressionRatio = compressed?.length ? compressed.length / bytes.length : null;
  const planeThreshold = SIGNAL_P_VALUE / 8;
  const worstPlane = planes.reduce((a, b) => a.pValue < b.pValue ? a : b);
  const checks = [
    check('monobit', 'Bit balance', pStatus(bitTest.pValue), 'NIST-style frequency test over every bit.', { pValue: bitTest.pValue }),
    check('runs', 'Bit transitions', pStatus(runs.pValue), runs.applicable ? 'NIST-style runs test, conditional on adequate bit balance.' : 'Not applicable: bit balance failed the runs-test prerequisite.', { pValue: runs.pValue }),
    check('byte-distribution', 'Byte distribution', pStatus(byteStats.pValue), 'Chi-square goodness of fit against 256 equally likely byte values.', { pValue: byteStats.pValue }),
    check('serial-correlation', 'Adjacent-byte correlation', pStatus(correlation.pValue), correlation.method, { pValue: correlation.pValue }),
    check('bit-planes', 'Individual bit positions', pStatus(worstPlane.pValue, planeThreshold), 'Eight bit-position tests with a 0.001/8 Bonferroni signal threshold.', { pValue: worstPlane.pValue, plane: worstPlane.plane }),
    check('repeated-blocks', 'Repeated 16/32-byte blocks', blocks32.duplicateBlocks || blocks16.duplicateBlocks ? 'signal' : 'pass', 'Exact non-overlapping block comparison. A repeat is strong evidence of structure, not a keyspace estimate.', { blocks16, blocks32 }),
    check('compression', 'Gzip compression', compressionRatio === null ? 'skipped' : compressionRatio < 0.5 ? 'signal' : compressionRatio < 0.95 ? 'review' : 'pass', compressionRatio === null ? 'CompressionStream unavailable; use the Node CLI for this check.' : 'Compressed size / original size. Strong compression indicates redundancy.', { ratio: compressionRatio }),
    check('sample-size', 'Sample size', bytes.length >= RECOMMENDED_ENTROPY_BYTES ? 'pass' : 'review', `${bytes.length.toLocaleString('en-US')} bytes; ${RECOMMENDED_ENTROPY_BYTES.toLocaleString('en-US')} or more is recommended.`, { bytes: bytes.length }),
  ];
  const signals = checks.filter((item) => item.status === 'signal').length;
  const reviews = checks.filter((item) => item.status === 'review').length;
  return {
    schemaVersion: ENTROPY_SCHEMA_VERSION,
    kind: 'entropy-audit',
    createdAt: options.now ?? new Date().toISOString(),
    input: { label: String(options.label ?? 'Unnamed sample').slice(0, 120), format: options.format ?? 'binary', bytes: bytes.length, sha256: digest },
    verdict: signals ? 'statistical-signal' : reviews ? 'review' : 'no-anomaly-detected',
    summary: { signals, reviews, checksPassed: checks.filter((item) => item.status === 'pass').length, checksSkipped: checks.filter((item) => item.status === 'skipped').length },
    metrics: {
      monobit: bitTest, runs, bytes: { histogram: byteStats.histogram, chiSquare: byteStats.chiSquare, degreesOfFreedom: byteStats.degreesOfFreedom, pValue: byteStats.pValue, shannonBitsPerByte: byteStats.shannonBitsPerByte, empiricalMinEntropyBitsPerByte: byteStats.empiricalMinEntropyBitsPerByte, distinctBytes: byteStats.distinctBytes },
      serialCorrelation: correlation, bitPlanes: planes, blocks16, blocks32, longestBitRun: longestRun, compression: { algorithm: 'gzip', ratio: compressionRatio, compressedBytes: compressed?.length ?? null },
    },
    checks,
    limitations: LIMITATIONS,
  };
}
