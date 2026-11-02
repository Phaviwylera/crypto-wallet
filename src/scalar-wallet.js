import { parseSearchRange } from './search-range.js';

function secureRandomBytes(bytes) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure browser randomness is unavailable. Use HTTPS or localhost.');
  }
  return globalThis.crypto.getRandomValues(bytes);
}

// Rejection sampling avoids modulo bias. The interval itself may still be
// deliberately small and therefore unsuitable for storing real funds.
export function randomScalarInRange(lower, upper, randomBytes = secureRandomBytes) {
  const { start, count } = parseSearchRange(lower, upper);
  if (count === 1n) return start;

  const bits = (count - 1n).toString(2).length;
  const byteLength = Math.ceil(bits / 8);
  const unusedBits = byteLength * 8 - bits;
  const firstByteMask = 0xff >>> unusedBits;

  for (;;) {
    const bytes = randomBytes(new Uint8Array(byteLength));
    if (!(bytes instanceof Uint8Array) || bytes.length !== byteLength) {
      throw new Error('Randomness provider returned an invalid byte array.');
    }
    bytes[0] &= firstByteMask;
    let candidate = 0n;
    for (const byte of bytes) candidate = (candidate << 8n) | BigInt(byte);
    if (candidate < count) return start + candidate;
  }
}

export function scalarWalletExport(result) {
  return `SEEDLAB BOUNDED SCALAR WALLET\n\nNetwork: ${result.networkLabel}\nLower scalar (inclusive): ${result.lower}\nUpper scalar (inclusive): ${result.upper}\nPrivate scalar (decimal): ${result.scalar}\nPrivate key (32-byte hex): ${result.privateKey}\nAddress: ${result.address}\n\nSECURITY: This private key controls the address. Keep it secret. A key drawn from a small or known interval can be brute-forced; use bounded keys for testing/recovery only, not for real funds. Generated locally in the browser.\n`;
}
