import { secp256k1 } from '@noble/curves/secp256k1.js';
import { normalizeZ } from '@noble/curves/abstract/curve.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const LOWER = 100_000n;
const UPPER = 1_100_000n;
const TOY_SECRET = 345_678n;
const WIDTH = UPPER - LOWER;
const BASE = secp256k1.Point.BASE;
const STEP_SIZES = [1n, 64n, 128n, 256n, 512n, 1024n, 2048n, 4096n];
const MAX_STEPS = Math.ceil(24 * Math.sqrt(Number(WIDTH)));

function pointKey(point) {
  return bytesToHex(point.toBytes(true));
}

function jumpIndex(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return (hash >>> 0) % STEP_SIZES.length;
}

export function runPollardKangarooDemo() {
  const jumpPoints = STEP_SIZES.map((distance) => BASE.multiply(distance));
  const targetPoint = BASE.multiply(TOY_SECRET);
  const shiftedTarget = targetPoint.add(BASE.multiply(LOWER).negate());
  // Interleave the two walks and stop as soon as either reaches a point already
  // visited by the other. Store full compressed points so hash collisions cannot
  // be mistaken for curve-point collisions.
  const startedAt = performance.now();
  const tamePoints = new Map();
  const wildPoints = new Map();
  let tamePoint = BASE.multiply(WIDTH);
  let wildPoint = shiftedTarget;
  let tameDistance = 0n;
  let wildDistance = 0n;
  let tameSteps = 0;
  let wildSteps = 0;
  let recovered = null;
  let collision = null;

  const checkCollision = (key, tameRecord, wildRecord) => {
    const offset = WIDTH + tameRecord.distance - wildRecord.distance;
    const candidate = LOWER + offset;
    if (candidate < LOWER || candidate > UPPER || !BASE.multiply(candidate).equals(targetPoint)) return false;
    recovered = candidate;
    collision = {
      point: `0x${key}`,
      tameDistance: tameRecord.distance.toString(),
      wildDistance: wildRecord.distance.toString(),
      offset: offset.toString(),
      tameStep: tameRecord.step,
      wildStep: wildRecord.step,
    };
    return true;
  };

  while (tameSteps < MAX_STEPS && wildSteps < MAX_STEPS) {
    // The walks are independent until the collision check, so convert both
    // projective points to affine with a single batched inversion.
    const [tameAffine, wildAffine] = normalizeZ(secp256k1.Point, [tamePoint, wildPoint]);
    const tameBytes = tameAffine.toBytes(true);
    const tameKey = bytesToHex(tameBytes);
    const tameRecord = { distance: tameDistance, step: tameSteps };
    if (wildPoints.has(tameKey) && checkCollision(tameKey, tameRecord, wildPoints.get(tameKey))) break;
    if (!tamePoints.has(tameKey)) tamePoints.set(tameKey, tameRecord);
    const tameJump = jumpIndex(tameBytes);
    tamePoint = tamePoint.add(jumpPoints[tameJump]);
    tameDistance += STEP_SIZES[tameJump];
    tameSteps += 1;

    const wildBytes = wildAffine.toBytes(true);
    const wildKey = bytesToHex(wildBytes);
    const wildRecord = { distance: wildDistance, step: wildSteps };
    if (tamePoints.has(wildKey) && checkCollision(wildKey, tamePoints.get(wildKey), wildRecord)) break;
    if (!wildPoints.has(wildKey)) wildPoints.set(wildKey, wildRecord);
    const wildJump = jumpIndex(wildBytes);
    wildPoint = wildPoint.add(jumpPoints[wildJump]);
    wildDistance += STEP_SIZES[wildJump];
    wildSteps += 1;
  }
  const elapsedMs = Math.max(performance.now() - startedAt, 0.01);

  return {
    lower: LOWER.toString(),
    upper: UPPER.toString(),
    width: WIDTH.toString(),
    targetPoint: `0x${pointKey(targetPoint)}`,
    shiftedTarget: `0x${pointKey(shiftedTarget)}`,
    tameStart: `0x${pointKey(BASE.multiply(WIDTH))}`,
    collision,
    recovered: recovered?.toString() ?? null,
    tameSteps,
    wildSteps,
    elapsedMs,
    walkStepsPerSecond: (tameSteps + wildSteps) * 1000 / elapsedMs,
    verified: recovered !== null && BASE.multiply(recovered).equals(targetPoint),
  };
}
