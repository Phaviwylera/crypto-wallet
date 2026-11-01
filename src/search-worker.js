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

function prefixKey(bytes) {
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
}

function matchesBytes(left, right) {
  if (!left || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function runWorker({ workerId, networkId, targetBytesList: targetInputs, targetBytes, start, end, chunkSize }) {
  stopRequested = false;
  const targets = (targetInputs ?? [targetBytes]).map((bytes) => Uint8Array.from(bytes));
  const targetBuckets = new Map();
  targets.forEach((bytes, index) => {
    const key = prefixKey(bytes);
    const bucket = targetBuckets.get(key) ?? [];
    bucket.push({ bytes, index });
    targetBuckets.set(key, bucket);
  });
  let scalar = BigInt(start);
  const endScalar = BigInt(end);
  const chunkSizeBigInt = BigInt(chunkSize);
  let tested = 0n;
  let point = BASE.multiply(scalar);
  const startedAt = performance.now();

  const reportCancelled = () => self.postMessage({
    type: 'cancelled', workerId, tested, currentScalar: scalar - 1n,
    elapsedMs: Math.max(performance.now() - startedAt, 0.01),
  });

  const runChunk = () => {
    if (stopRequested) {
      reportCancelled();
      return;
    }
    const proposedChunkEnd = scalar + chunkSizeBigInt - 1n;
    const chunkEnd = proposedChunkEnd < endScalar ? proposedChunkEnd : endScalar;
    while (scalar <= chunkEnd) {
      const payload = addressPayloadForPoint(point, networkId);
      tested += 1n;
      const bucket = payload ? targetBuckets.get(prefixKey(payload)) : null;
      const found = bucket?.find(({ bytes }) => matchesBytes(payload, bytes));
      if (found) {
        self.postMessage({
          type: 'match', workerId, tested, scalar, targetIndex: found.index,
          publicKey: `0x${hex(point.toBytes(false))}`,
          elapsedMs: Math.max(performance.now() - startedAt, 0.01),
        });
        return;
      }
      scalar += 1n;
      if (scalar <= endScalar) point = point.add(BASE);
    }

    const message = { workerId, tested, currentScalar: scalar - 1n, elapsedMs: Math.max(performance.now() - startedAt, 0.01) };
    if (stopRequested) {
      self.postMessage({ type: 'cancelled', ...message });
      return;
    }
    if (scalar > endScalar) {
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
