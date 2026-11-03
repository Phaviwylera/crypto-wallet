export const SPACE_GRID_SIZE = 64;
export const SPACE_GRID_BITS = 6;
export const SPACE_CELL_COUNT = SPACE_GRID_SIZE ** 3;
export const MAX_SPACE_CELL = SPACE_CELL_COUNT - 1;

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function assertBitLength(bitLength) {
  if (!Number.isInteger(bitLength) || bitLength < 8 || bitLength > 256 || bitLength % 8 !== 0) {
    throw new RangeError('Address payload bit length must be a multiple of 8 from 8 through 256.');
  }
}

function assertCell(cell) {
  if (!Number.isInteger(cell) || cell < 0 || cell > MAX_SPACE_CELL) {
    throw new RangeError(`Space cell must be an integer from 0 through ${MAX_SPACE_CELL}.`);
  }
}

export function bytesToUnsignedBigInt(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 32) {
    throw new TypeError('Address payload must be a Uint8Array containing 1–32 bytes.');
  }
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Map an unsigned payload integer to an inclusive 3D Morton cell without floats. */
export function scalarToSpaceCell(scalar, bitLength) {
  assertBitLength(bitLength);
  if (typeof scalar !== 'bigint') throw new TypeError('scalar must be a BigInt.');
  const maximum = (1n << BigInt(bitLength)) - 1n;
  if (scalar < 0n || scalar > maximum) throw new RangeError(`scalar must fit in ${bitLength} bits.`);
  return Number(scalar * BigInt(MAX_SPACE_CELL) / maximum);
}

/**
 * Return the exact inclusive 256-bit mapped-scalar interval for a cell.
 * A payload of B bits is left-aligned into 256 bits by shifting it 256-B bits.
 */
export function spaceCellToScalarRange(cell, bitLength) {
  assertBitLength(bitLength);
  assertCell(cell);
  const maximum = ((1n << BigInt(bitLength)) - 1n) << BigInt(256 - bitLength);
  const cells = BigInt(MAX_SPACE_CELL);
  const bigCell = BigInt(cell);
  const lower = ceilDiv(bigCell * maximum, cells);
  const upper = ceilDiv((bigCell + 1n) * maximum, cells) - 1n;
  return { lower, upper: upper > maximum ? maximum : upper };
}

export function spaceCellToGrid(cell) {
  assertCell(cell);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let bit = 0; bit < SPACE_GRID_BITS; bit += 1) {
    x |= ((cell >> (3 * bit)) & 1) << bit;
    y |= ((cell >> (3 * bit + 1)) & 1) << bit;
    z |= ((cell >> (3 * bit + 2)) & 1) << bit;
  }
  return { x, y, z };
}

export function gridToSpaceCell(x, y, z) {
  if (![x, y, z].every((value) => Number.isInteger(value) && value >= 0 && value < SPACE_GRID_SIZE)) {
    throw new RangeError(`x, y and z must be integers from 0 through ${SPACE_GRID_SIZE - 1}.`);
  }
  let cell = 0;
  for (let bit = 0; bit < SPACE_GRID_BITS; bit += 1) {
    cell |= ((x >> bit) & 1) << (3 * bit);
    cell |= ((y >> bit) & 1) << (3 * bit + 1);
    cell |= ((z >> bit) & 1) << (3 * bit + 2);
  }
  return cell;
}

export function spaceCellPosition(cell) {
  const { x, y, z } = spaceCellToGrid(cell);
  const scale = 2 / (SPACE_GRID_SIZE - 1);
  return [x * scale - 1, y * scale - 1, z * scale - 1];
}

export function payloadToSpace(payload) {
  const value = bytesToUnsignedBigInt(payload);
  const bitLength = payload.length * 8;
  const cell = scalarToSpaceCell(value, bitLength);
  const { x, y, z } = spaceCellToGrid(cell);
  const { lower, upper } = spaceCellToScalarRange(cell, bitLength);
  const mappedScalar = value << BigInt(256 - bitLength);
  return {
    value,
    bitLength,
    cell,
    x,
    y,
    z,
    position: spaceCellPosition(cell),
    mappedScalar,
    scalarLower: lower,
    scalarUpper: upper,
    mappedScalarHex: `0x${mappedScalar.toString(16).padStart(64, '0')}`,
    scalarLowerHex: `0x${lower.toString(16).padStart(64, '0')}`,
    scalarUpperHex: `0x${upper.toString(16).padStart(64, '0')}`,
  };
}
