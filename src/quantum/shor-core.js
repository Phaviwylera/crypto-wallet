/**
 * Educational N=15 Shor demo. The browser mode is an exact classical statevector
 * simulation of the same 12-qubit compiled circuit used by the Qiskit/Aer CLI.
 * It is not quantum hardware and accepts no wallet/address/key material.
 */
export const N = 15;
export const COUNT_QUBITS = 8;
export const TARGET_QUBITS = 4;
export const BASES = [2, 4, 7, 8, 11, 13];
const DIM = 1 << (COUNT_QUBITS + TARGET_QUBITS);
const COUNT_MASK = (1 << COUNT_QUBITS) - 1;

export function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}
export function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = BigInt(base) % BigInt(modulus);
  let e = BigInt(exponent);
  const m = BigInt(modulus);
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return Number(result);
}
export function validateBase(a) {
  if (!BASES.includes(a)) throw new Error('Base must be one of 2, 4, 7, 8, 11, 13.');
}
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function randomSeed() {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0];
}

/** Compiled SWAP/X permutation on the 4 target qubits, exactly as c_amod15. */
export function modularPermutation(a, power) {
  validateBase(a);
  if (!Number.isInteger(power) || power < 0) throw new Error('power must be a nonnegative integer.');
  const perm = new Uint8Array(16);
  for (let value = 0; value < 16; value++) {
    let bits = value;
    const swap = (i, j) => {
      const bi = (bits >>> i) & 1, bj = (bits >>> j) & 1;
      if (bi !== bj) bits ^= (1 << i) | (1 << j);
    };
    for (let step = 0; step < power; step++) {
      if (a === 2 || a === 13) { swap(0, 1); swap(1, 2); swap(2, 3); }
      if (a === 7 || a === 8) { swap(2, 3); swap(1, 2); swap(0, 1); }
      if (a === 4 || a === 11) { swap(0, 2); swap(1, 3); }
      if (a === 7 || a === 11 || a === 13) bits ^= 0b1111;
    }
    perm[value] = bits;
  }
  return perm;
}

function applyH(re, im, qubit) {
  const bit = 1 << qubit;
  const inv = Math.SQRT1_2;
  for (let i = 0; i < DIM; i++) {
    if (i & bit) continue;
    const j = i | bit;
    const ar = re[i], ai = im[i], br = re[j], bi = im[j];
    re[i] = (ar + br) * inv; im[i] = (ai + bi) * inv;
    re[j] = (ar - br) * inv; im[j] = (ai - bi) * inv;
  }
}
function applySwap(re, im, q1, q2) {
  const b1 = 1 << q1, b2 = 1 << q2;
  for (let i = 0; i < DIM; i++) {
    if ((i & b1) && !(i & b2)) {
      const j = (i ^ b1) | b2;
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
}
function applyControlledPhase(re, im, control, target, angle) {
  const mask = (1 << control) | (1 << target);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  for (let i = 0; i < DIM; i++) {
    if ((i & mask) !== mask) continue;
    const r = re[i], m = im[i];
    re[i] = r * cos - m * sin;
    im[i] = r * sin + m * cos;
  }
}
function applyControlledPermutation(re, im, control, perm) {
  const nextRe = re.slice(), nextIm = im.slice();
  const controlBit = 1 << control;
  for (let i = 0; i < DIM; i++) {
    if (!(i & controlBit)) continue;
    const target = (i >>> COUNT_QUBITS) & 0b1111;
    const j = (i & ~(0b1111 << COUNT_QUBITS)) | (perm[target] << COUNT_QUBITS);
    nextRe[j] = re[i]; nextIm[j] = im[i];
  }
  re.set(nextRe); im.set(nextIm);
}

/** Exact statevector simulation of the compiled 8+4 qubit phase-estimation circuit. */
export function simulatePeriodCircuit(a) {
  validateBase(a);
  const re = new Float64Array(DIM), im = new Float64Array(DIM);
  re[1 << COUNT_QUBITS] = 1; // target |0001>, counting |00000000>
  for (let q = 0; q < COUNT_QUBITS; q++) applyH(re, im, q);
  for (let q = 0; q < COUNT_QUBITS; q++) applyControlledPermutation(re, im, q, modularPermutation(a, 2 ** q));
  // qft_dagger: swaps first, then controlled phases and Hadamards.
  for (let j = 0; j < COUNT_QUBITS / 2; j++) applySwap(re, im, j, COUNT_QUBITS - j - 1);
  for (let j = 0; j < COUNT_QUBITS; j++) {
    for (let m = 0; m < j; m++) applyControlledPhase(re, im, m, j, -Math.PI / 2 ** (j - m));
    applyH(re, im, j);
  }
  const probabilities = new Float64Array(1 << COUNT_QUBITS);
  let total = 0;
  for (let i = 0; i < DIM; i++) {
    const p = re[i] * re[i] + im[i] * im[i];
    probabilities[i & COUNT_MASK] += p;
    total += p;
  }
  for (let i = 0; i < probabilities.length; i++) probabilities[i] /= total;
  return { probabilities, normalization: total };
}

export function sampleCounts(probabilities, shots, rng) {
  if (!Number.isInteger(shots) || shots < 1 || shots > 1024) throw new Error('shots must be 1 through 1024.');
  const cumulative = new Float64Array(probabilities.length);
  let sum = 0;
  for (let i = 0; i < probabilities.length; i++) { sum += probabilities[i]; cumulative[i] = sum; }
  const counts = {};
  const samples = [];
  for (let shot = 0; shot < shots; shot++) {
    const target = rng() * sum;
    let value = cumulative.length - 1;
    for (let i = 0; i < cumulative.length; i++) { if (target <= cumulative[i]) { value = i; break; } }
    const bitstring = value.toString(2).padStart(COUNT_QUBITS, '0');
    counts[bitstring] = (counts[bitstring] ?? 0) + 1;
    samples.push({ bitstring, value, phase: value / 2 ** COUNT_QUBITS });
  }
  return { counts, samples };
}

/** Limit a rational num/den to the largest denominator <= maxDen (continued fractions). */
export function limitDenominator(num, den, maxDen) {
  if (den <= 0 || maxDen < 1) throw new Error('Invalid fraction bounds.');
  if (num === 0) return { numerator: 0, denominator: 1 };
  let p0 = 0, q0 = 1, p1 = 1, q1 = 0;
  let n = num, d = den;
  let best = { numerator: p0, denominator: q0 };
  while (d) {
    const a = Math.floor(n / d);
    const p2 = a * p1 + p0, q2 = a * q1 + q0;
    if (q2 > maxDen) break;
    best = { numerator: p2, denominator: q2 };
    p0 = p1; q0 = q1; p1 = p2; q1 = q2;
    [n, d] = [d, n - a * d];
  }
  return best;
}

export function inferPeriodFromValue(value, a, modulus = N) {
  validateBase(a);
  const frac = limitDenominator(value, 2 ** COUNT_QUBITS, modulus - 1);
  const candidate = frac.denominator;
  const info = { phase: value / 2 ** COUNT_QUBITS, numerator: frac.numerator, denominator: candidate, candidatePeriod: candidate, period: null, method: null };
  if (value === 0) return info;
  for (let multiple = 1; candidate * multiple < modulus; multiple++) {
    const r = candidate * multiple;
    if (modPow(a, r, modulus) === 1) {
      info.period = r;
      info.method = multiple === 1 ? 'continued-fraction' : `validated-multiple-x${multiple}`;
      return info;
    }
  }
  return info;
}

export function factorsFromPeriod(a, r, modulus = N) {
  validateBase(a);
  if (!Number.isInteger(r) || r <= 0 || r % 2 !== 0) return { ok: false, reason: 'odd-period', detail: `Period r=${r} is not a positive even integer.` };
  const x = modPow(a, r / 2, modulus);
  if (x === modulus - 1) return { ok: false, reason: 'trivial-minus-one', detail: `a^(r/2) ≡ -1 mod ${modulus}; retry.`, x };
  const gcdMinus = gcd(x - 1, modulus), gcdPlus = gcd(x + 1, modulus);
  const p = gcdMinus > 1 && gcdMinus < modulus ? gcdMinus : gcdPlus > 1 && gcdPlus < modulus ? gcdPlus : null;
  if (p === null) return { ok: false, reason: 'no-nontrivial-gcd', detail: 'Neither GCD produced a nontrivial factor.', x, gcdMinus, gcdPlus };
  const q = modulus / p;
  const factors = [p, q].sort((x, y) => x - y);
  return { ok: true, factors, x, gcdMinus, gcdPlus, detail: `${factors[0]} × ${factors[1]} = ${modulus}` };
}

export function runShorSimulation({ base = null, seed = null, shots = 1, maxAttempts = 10 } = {}) {
  if (base !== null) validateBase(base);
  if (!Number.isInteger(shots) || shots < 1 || shots > 1024) throw new Error('shots must be 1 through 1024.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('maxAttempts must be 1 through 10.');
  const actualSeed = seed ?? randomSeed();
  if (!Number.isInteger(actualSeed) || actualSeed < 0 || actualSeed > 0xFFFFFFFF) throw new Error('seed must be 0 through 4294967295.');
  const rng = mulberry32(actualSeed);
  const events = [{ type: 'start', N, maxAttempts, seed: actualSeed, shots, base }];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const a = base ?? BASES[Math.floor(rng() * BASES.length)];
    const common = gcd(a, N);
    if (common !== 1) {
      const factors = [common, N / common].sort((x, y) => x - y);
      events.push({ type: 'classical-gcd', attempt, a, gcd: common, factors });
      return finish(events, factors, actualSeed, { base, shots, maxAttempts });
    }
    events.push({ type: 'attempt', attempt, a });
    const { probabilities, normalization } = simulatePeriodCircuit(a);
    const { counts, samples } = sampleCounts(probabilities, shots, rng);
    const first = samples[0];
    events.push({ type: 'phase', attempt, a, backend: 'browser-statevector', hardware: false, N, countingQubits: COUNT_QUBITS, targetQubits: TARGET_QUBITS, shots, seed: actualSeed, phase: first.phase, bitstring: first.bitstring, samples, counts, probabilities: Array.from(probabilities), normalization });
    if (first.phase === 0) { events.push({ type: 'retry', attempt, reason: 'zero-phase' }); continue; }
    const periodInfo = inferPeriodFromValue(first.value, a, N);
    events.push({ type: 'period', attempt, a, ...periodInfo });
    if (periodInfo.period === null) { events.push({ type: 'retry', attempt, reason: 'period-not-validated' }); continue; }
    const check = factorsFromPeriod(a, periodInfo.period, N);
    events.push({ type: 'factor-check', attempt, a, r: periodInfo.period, ...check });
    if (check.ok) {
      events.push({ type: 'success', attempt, a, r: periodInfo.period, factors: check.factors });
      return finish(events, check.factors, actualSeed, { base, shots, maxAttempts });
    }
  }
  events.push({ type: 'failure', reason: 'max-attempts' });
  return finish(events, null, actualSeed, { base, shots, maxAttempts });
}

function finish(events, factors, seed, options) {
  return {
    schemaVersion: '1.0.0', kind: 'shor-n15', backend: 'browser-statevector', hardware: false, N,
    countingQubits: COUNT_QUBITS, targetQubits: TARGET_QUBITS, shots: options.shots, seed, base: options.base,
    maxAttempts: options.maxAttempts, success: factors !== null, factors, events,
    scope: 'Educational N=15 factoring only. Classical statevector simulation; no wallet, address, public-key, or private-key input.',
  };
}
