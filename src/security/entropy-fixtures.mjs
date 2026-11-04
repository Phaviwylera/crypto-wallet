/** Synthetic byte generators for regression tests. None derives keys or addresses. */
export const ENTROPY_FIXTURES = [
  { id: 'csprng', label: 'CSPRNG control', description: 'Fresh Web Crypto / Node crypto bytes. A control, not a certification.', expected: 'control' },
  { id: 'biased', label: 'Biased bytes', description: 'The high bit is forced to zero.', expected: 'signal' },
  { id: 'repeating', label: 'Repeating block', description: 'One 32-byte block repeated across the sample.', expected: 'signal' },
  { id: 'counter', label: 'Counter stream', description: 'A predictable 0–255 counter.', expected: 'signal' },
  { id: 'xorshift32', label: 'Fixed-seed xorshift32', description: 'Predictable 32-bit state. May look statistically random.', expected: 'predictable-source' },
  { id: 'mt19937', label: 'Fixed-seed MT19937', description: 'Non-cryptographic PRNG. Statistical tests do not establish seed secrecy.', expected: 'predictable-source' },
];

export function mt19937(seed) {
  const state = new Uint32Array(624);
  state[0] = seed >>> 0;
  for (let i = 1; i < 624; i++) state[i] = (Math.imul(1812433253, state[i - 1] ^ (state[i - 1] >>> 30)) + i) >>> 0;
  let index = 624;
  return () => {
    if (index >= 624) {
      for (let i = 0; i < 624; i++) {
        const y = (state[i] & 0x80000000) | (state[(i + 1) % 624] & 0x7fffffff);
        state[i] = state[(i + 397) % 624] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0);
      }
      index = 0;
    }
    let y = state[index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  };
}

export function generateEntropyFixture(id, length = 65536, options = {}) {
  if (!ENTROPY_FIXTURES.some((fixture) => fixture.id === id)) throw new Error(`Unknown fixture: ${id}`);
  if (!Number.isInteger(length) || length < 1024 || length > 8 * 1024 * 1024) throw new RangeError('Fixture length must be 1024 through 8388608 bytes.');
  const bytes = new Uint8Array(length);
  if (id === 'csprng') {
    for (let offset = 0; offset < length; offset += 65536) globalThis.crypto.getRandomValues(bytes.subarray(offset, Math.min(length, offset + 65536)));
  } else if (id === 'biased') {
    const next = mt19937(5489);
    for (let i = 0; i < length; i += 4) {
      const value = next();
      for (let j = 0; j < 4 && i + j < length; j++) bytes[i + j] = ((value >>> (8 * j)) & 255) & 0x7f;
    }
  } else if (id === 'repeating') {
    const block = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 3);
    for (let i = 0; i < length; i++) bytes[i] = block[i % 32];
  } else if (id === 'counter') {
    for (let i = 0; i < length; i++) bytes[i] = i & 255;
  } else if (id === 'xorshift32') {
    let state = (options.seed ?? 0x6d2b79f5) >>> 0 || 1;
    for (let i = 0; i < length; i += 4) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      for (let j = 0; j < 4 && i + j < length; j++) bytes[i + j] = (state >>> (8 * j)) & 255;
    }
  } else if (id === 'mt19937') {
    const next = mt19937(options.seed ?? 5489);
    for (let i = 0; i < length; i += 4) {
      const value = next();
      for (let j = 0; j < 4 && i + j < length; j++) bytes[i + j] = (value >>> (8 * j)) & 255;
    }
  }
  return bytes;
}
