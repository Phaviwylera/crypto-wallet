import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SPACE_CELL,
  SPACE_CELL_COUNT,
  SPACE_GRID_SIZE,
  bytesToUnsignedBigInt,
  gridToSpaceCell,
  payloadToSpace,
  spaceCellPosition,
  spaceCellToGrid,
  spaceCellToScalarRange,
} from '../src/wallet-space-math.js';
import { collectWalletSpacePoints } from '../src/wallet-space-data.js';

function bytes(hex) {
  return Uint8Array.from(hex.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

test('WETH maps to the established cell and exact 256-bit scalar', () => {
  const address = 'c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const point = payloadToSpace(bytes(address));
  assert.equal(point.bitLength, 160);
  assert.equal(point.cell, 0x300a9);
  assert.equal(point.mappedScalarHex, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000');
  assert.ok(point.scalarLower <= point.mappedScalar);
  assert.ok(point.mappedScalar <= point.scalarUpper);
  assert.equal(gridToSpaceCell(point.x, point.y, point.z), point.cell);
});

test('zero and maximum 160-bit payloads map to exact opposite cells', () => {
  const zero = payloadToSpace(new Uint8Array(20));
  assert.equal(zero.cell, 0);
  assert.deepEqual([zero.x, zero.y, zero.z], [0, 0, 0]);
  assert.equal(zero.scalarLower, 0n);

  const maximum = payloadToSpace(new Uint8Array(20).fill(0xff));
  assert.equal(maximum.cell, MAX_SPACE_CELL);
  assert.deepEqual([maximum.x, maximum.y, maximum.z], [63, 63, 63]);
  assert.equal(maximum.mappedScalarHex, `0x${'ff'.repeat(20)}${'00'.repeat(12)}`);
  assert.equal(maximum.scalarLower, maximum.mappedScalar);
  assert.equal(maximum.scalarUpper, maximum.mappedScalar);
});

test('all 262,144 3D Morton cells and positions round-trip', () => {
  assert.equal(SPACE_CELL_COUNT, 262144);
  for (let cell = 0; cell < SPACE_CELL_COUNT; cell += 1) {
    const { x, y, z } = spaceCellToGrid(cell);
    assert.equal(gridToSpaceCell(x, y, z), cell);
    const position = spaceCellPosition(cell);
    assert.equal(position.length, 3);
    assert.ok(position.every((value) => value >= -1 && value <= 1));
  }
  assert.equal(SPACE_GRID_SIZE, 64);
});

test('random 160/256-bit payloads stay inside their exact scalar ranges', () => {
  let state = 0x12345678;
  const randomByte = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
  for (const length of [20, 32]) {
    for (let index = 0; index < 1000; index += 1) {
      const payload = Uint8Array.from({ length }, randomByte);
      const point = payloadToSpace(payload);
      assert.ok(point.scalarLower <= point.mappedScalar);
      assert.ok(point.mappedScalar <= point.scalarUpper);
      assert.equal(bytesToUnsignedBigInt(payload), point.value);
      const range = spaceCellToScalarRange(point.cell, point.bitLength);
      assert.equal(range.lower, point.scalarLower);
      assert.equal(range.upper, point.scalarUpper);
    }
  }
});

test('invalid payloads and coordinates are rejected', () => {
  assert.throws(() => payloadToSpace(new Uint8Array()), /1–32 bytes/);
  assert.throws(() => payloadToSpace(new Uint8Array(33)), /1–32 bytes/);
  assert.throws(() => spaceCellToGrid(-1), /Space cell/);
  assert.throws(() => gridToSpaceCell(64, 0, 0), /x, y and z/);
});

test('collector combines duplicate public addresses without copying secrets', () => {
  const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const networks = {
    ethereum: { label: 'Ethereum', family: 'evm' },
    bnb: { label: 'BNB Smart Chain', family: 'evm' },
  };
  const parseAddress = (address, networkId) => {
    if (!networks[networkId] || !/^0x[0-9a-fA-F]{40}$/.test(address)) return { valid: false };
    return { valid: true, display: address, bytes: bytes(address.slice(2)) };
  };
  const secret = 'never-copy-this-seed';
  const points = collectWalletSpacePoints({
    wallet: { stage: 5, address: weth },
    selectedNetworkId: 'ethereum',
    networks,
    scanState: { results: [{ valid: true, input: secret, addresses: { bnb: weth, ethereum: usdc } }] },
    searchAddressFile: { addresses: [weth] },
    labAddressInput: weth,
    keyRecovery: { network: 'ethereum', result: null, batchResults: [{ address: usdc }] },
    puzzles: [],
    parseAddress,
  });
  assert.equal(points.length, 2);
  const current = points.find((point) => point.address === weth);
  assert.equal(current.source, 'session');
  assert.ok(current.networkLabel.includes('Ethereum'));
  assert.ok(current.networkLabel.includes('BNB Smart Chain'));
  assert.ok(!JSON.stringify(points).includes(secret));
  for (const point of points) {
    assert.equal(point.privateKey, undefined);
    assert.equal(point.input, undefined);
    assert.ok(point.payload instanceof Uint8Array);
  }
});
