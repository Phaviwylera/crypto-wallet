import { bytesToHex } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

// This is a toy demonstration only. The secret is deliberately small and known.
// It never reads or accepts real wallet addresses, public keys, or private keys.
const LOWER = 100_000n;
const UPPER = 1_100_000n;
const TOY_SECRET = 345_678n;
const WIDTH = UPPER - LOWER;
const BASE = secp256k1.Point.BASE;
const STEP_SIZES = [1n, 64n, 128n, 256n, 512n, 1024n, 2048n, 4096n];
const MAX_STEPS = Math.ceil(24 * Math.sqrt(Number(WIDTH)));

if (TOY_SECRET < LOWER || TOY_SECRET > UPPER) throw new Error('Toy secret must be inside the demonstration interval.');

function pointKey(point) {
  return bytesToHex(point.toBytes(true));
}

function jumpIndex(point) {
  // A small deterministic hash selects the same jump whenever a point repeats.
  let hash = 0x811c9dc5;
  for (const byte of point.toBytes(true)) hash = Math.imul(hash ^ byte, 0x01000193);
  return (hash >>> 0) % STEP_SIZES.length;
}

const jumpPoints = STEP_SIZES.map((distance) => BASE.multiply(distance));
const targetPoint = BASE.multiply(TOY_SECRET);
const shiftedTarget = targetPoint.add(BASE.multiply(LOWER).negate());
const tamePoints = new Map();
let tamePoint = BASE.multiply(WIDTH);
let tameDistance = 0n;
let tameSteps = 0;

// Tame walk starts at WIDTH*G and records visited points and their distances.
for (; tameSteps < MAX_STEPS; tameSteps += 1) {
  const key = pointKey(tamePoint);
  if (!tamePoints.has(key)) tamePoints.set(key, tameDistance);
  const index = jumpIndex(tamePoint);
  tamePoint = tamePoint.add(jumpPoints[index]);
  tameDistance += STEP_SIZES[index];
}

// Wild walk starts at (secret - LOWER)*G. A collision reveals the offset.
let wildPoint = shiftedTarget;
let wildDistance = 0n;
let wildSteps = 0;
let recovered = null;
for (; wildSteps < MAX_STEPS; wildSteps += 1) {
  const tameAtDistance = tamePoints.get(pointKey(wildPoint));
  if (tameAtDistance !== undefined) {
    const offset = WIDTH + tameAtDistance - wildDistance;
    const candidate = LOWER + offset;
    if (candidate >= LOWER && candidate <= UPPER && BASE.multiply(candidate).equals(targetPoint)) {
      recovered = candidate;
      break;
    }
  }
  const index = jumpIndex(wildPoint);
  wildPoint = wildPoint.add(jumpPoints[index]);
  wildDistance += STEP_SIZES[index];
}

console.log('Pollard kangaroo · synthetic toy example');
console.log(`Search interval: [${LOWER.toLocaleString()}, ${UPPER.toLocaleString()}] (${WIDTH.toLocaleString()} gap)`);
console.log(`Toy secret selected internally: ${TOY_SECRET.toLocaleString()}`);
console.log(`Tame steps: ${tameSteps.toLocaleString()}; wild steps: ${wildSteps.toLocaleString()}`);
if (recovered === null) {
  console.log('No collision produced an in-range answer in this run; increase MAX_STEPS and retry.');
  process.exitCode = 1;
} else {
  console.log(`Recovered toy scalar: ${recovered.toLocaleString()}`);
  console.log(`Independent verification Q = dG: ${BASE.multiply(recovered).equals(targetPoint) ? 'passed' : 'failed'}`);
}
console.log('This toy uses a known, deliberately small interval. It is not a wallet-recovery tool.');
