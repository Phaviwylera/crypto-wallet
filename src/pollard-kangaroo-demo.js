import { secp256k1 } from '@noble/curves/secp256k1.js';
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

function jumpIndex(point) {
  let hash = 0x811c9dc5;
  for (const byte of point.toBytes(true)) hash = Math.imul(hash ^ byte, 0x01000193);
  return (hash >>> 0) % STEP_SIZES.length;
}

export function runPollardKangarooDemo() {
  const jumpPoints = STEP_SIZES.map((distance) => BASE.multiply(distance));
  const targetPoint = BASE.multiply(TOY_SECRET);
  const shiftedTarget = targetPoint.add(BASE.multiply(LOWER).negate());
  const tamePoints = new Map();
  let tamePoint = BASE.multiply(WIDTH);
  let tameDistance = 0n;
  let tameSteps = 0;

  for (; tameSteps < MAX_STEPS; tameSteps += 1) {
    const key = pointKey(tamePoint);
    if (!tamePoints.has(key)) tamePoints.set(key, { distance: tameDistance, step: tameSteps });
    const index = jumpIndex(tamePoint);
    tamePoint = tamePoint.add(jumpPoints[index]);
    tameDistance += STEP_SIZES[index];
  }

  let wildPoint = shiftedTarget;
  let wildDistance = 0n;
  let wildSteps = 0;
  let recovered = null;
  let collision = null;
  for (; wildSteps < MAX_STEPS; wildSteps += 1) {
    const collisionKey = pointKey(wildPoint);
    const tameRecord = tamePoints.get(collisionKey);
    if (tameRecord !== undefined) {
      const offset = WIDTH + tameRecord.distance - wildDistance;
      const candidate = LOWER + offset;
      if (candidate >= LOWER && candidate <= UPPER && BASE.multiply(candidate).equals(targetPoint)) {
        recovered = candidate;
        collision = {
          point: `0x${collisionKey}`,
          tameDistance: tameRecord.distance.toString(),
          wildDistance: wildDistance.toString(),
          offset: offset.toString(),
          tameStep: tameRecord.step,
          wildStep: wildSteps,
        };
        break;
      }
    }
    const index = jumpIndex(wildPoint);
    wildPoint = wildPoint.add(jumpPoints[index]);
    wildDistance += STEP_SIZES[index];
  }

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
    verified: recovered !== null && BASE.multiply(recovered).equals(targetPoint),
  };
}
