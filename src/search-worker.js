import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const BASE = secp256k1.Point.BASE;
const encoder = new TextEncoder();
let stopRequested = false;

function hex(bytes) {
  return bytesToHex(bytes);
}

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function hash160(bytes) {
  return ripemd160(sha256(bytes));
}

function taggedHash(tag, message) {
  const tagHash = sha256(encoder.encode(tag));
  return sha256(concatBytes(tagHash, tagHash, message));
}

function addressPayloadForPoint(point, networkId) {
  if (networkId === 'ethereum' || networkId === 'bnb' || networkId === 'tron') {
    return keccak_256(point.toBytes(false).slice(1)).slice(12);
  }

  if (networkId === 'bitcoinTaproot') {
    const publicKey = point.toBytes(false);
    const evenPoint = (publicKey[64] & 1) === 1 ? point.negate() : point;
    const internalX = evenPoint.toBytes(false).slice(1, 33);
    const tweak = BigInt(`0x${hex(taggedHash('TapTweak', internalX))}`);
    if (tweak >= ORDER) return null;
    const outputPoint = evenPoint.add(BASE.multiply(tweak));
    if (outputPoint.equals(secp256k1.Point.ZERO)) return null;
    return outputPoint.toBytes(false).slice(1, 33);
  }

  const keyHash = hash160(point.toBytes(true));
  if (networkId === 'bitcoin' || networkId === 'bitcoinLegacy' || networkId === 'bnbBeacon') return keyHash;
  if (networkId === 'bitcoinNested') return hash160(new Uint8Array([0x00, 0x14, ...keyHash]));
  throw new Error(`Unsupported search profile: ${networkId}`);
}

function matchesBytes(left, right) {
  if (!left || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function runWorker({ workerId, networkId, targetBytes: targetInput, start, end, chunkSize }) {
  stopRequested = false;
  const targetBytes = Uint8Array.from(targetInput);
  let scalar = start;
  let tested = 0;
  let point = BASE.multiply(BigInt(start));
  const startedAt = performance.now();

  const reportCancelled = () => self.postMessage({
    type: 'cancelled', workerId, tested, currentScalar: scalar - 1,
    elapsedMs: Math.max(performance.now() - startedAt, 0.01),
  });

  const runChunk = () => {
    if (stopRequested) {
      reportCancelled();
      return;
    }
    const chunkEnd = Math.min(end, scalar + chunkSize - 1);
    while (scalar <= chunkEnd) {
      const payload = addressPayloadForPoint(point, networkId);
      tested += 1;
      if (matchesBytes(payload, targetBytes)) {
        self.postMessage({
          type: 'match', workerId, tested, scalar,
          publicKey: `0x${hex(point.toBytes(false))}`,
          elapsedMs: Math.max(performance.now() - startedAt, 0.01),
        });
        return;
      }
      scalar += 1;
      if (scalar <= end) point = point.add(BASE);
    }

    const message = { workerId, tested, currentScalar: scalar - 1, elapsedMs: Math.max(performance.now() - startedAt, 0.01) };
    if (stopRequested) {
      self.postMessage({ type: 'cancelled', ...message });
      return;
    }
    if (scalar > end) {
      self.postMessage({ type: 'done', ...message });
      return;
    }
    self.postMessage({ type: 'progress', ...message });
    setTimeout(runChunk, 0);
  };

  setTimeout(runChunk, 0);
}

self.onmessage = (event) => {
  if (event.data?.type === 'cancel') {
    stopRequested = true;
    return;
  }
  try {
    runWorker(event.data);
  } catch (error) {
    self.postMessage({ type: 'error', workerId: event.data?.workerId, message: error?.message ?? String(error) });
  }
};
