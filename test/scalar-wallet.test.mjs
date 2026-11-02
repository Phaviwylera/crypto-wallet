import test from 'node:test';
import assert from 'node:assert/strict';
import { randomScalarInRange, scalarWalletExport } from '../src/scalar-wallet.js';
import { MAX_SEARCH_SCALAR } from '../src/search-range.js';

function randomSequence(values) {
  const remaining = [...values];
  return (bytes) => {
    assert.ok(remaining.length, 'random sequence exhausted');
    bytes.set(remaining.shift());
    return bytes;
  };
}

test('singleton ranges return their only valid scalar without randomness', () => {
  let called = false;
  const rng = () => { called = true; throw new Error('must not be called'); };
  assert.equal(randomScalarInRange('7', '7', rng), 7n);
  assert.equal(randomScalarInRange(MAX_SEARCH_SCALAR.toString(), MAX_SEARCH_SCALAR.toString(), rng), MAX_SEARCH_SCALAR);
  assert.equal(called, false);
});

test('sampling includes both endpoints and rejects values above the interval', () => {
  assert.equal(randomScalarInRange('10', '20', randomSequence([[0]])), 10n);
  assert.equal(randomScalarInRange('10', '20', randomSequence([[10]])), 20n);
  assert.equal(randomScalarInRange('10', '20', randomSequence([[11], [5]])), 15n);
});

test('unused high bits are masked before rejection sampling', () => {
  const rng = randomSequence([[0xff, 0x0f], [0x27, 0x0f]]);
  assert.equal(randomScalarInRange('1', '10000', rng), 10000n);
});

test('full-width ranges use all 32 random bytes and preserve the lower endpoint', () => {
  const rng = randomSequence([new Array(32).fill(0)]);
  assert.equal(randomScalarInRange('1', MAX_SEARCH_SCALAR.toString(), rng), 1n);
});

test('invalid ranges and malformed random sources fail closed', () => {
  assert.throws(() => randomScalarInRange('0', '10', randomSequence([[0]])));
  assert.throws(() => randomScalarInRange('10', '9', randomSequence([[0]])));
  assert.throws(() => randomScalarInRange('1', '10', () => new Uint8Array(0)), /invalid byte array/);
});

test('TXT export records exact bounds, key, address and sensitive-data warning', () => {
  const output = scalarWalletExport({
    networkLabel: 'Ethereum', lower: '10', upper: '20', scalar: '15',
    privateKey: '0x' + '0'.repeat(63) + 'f', address: '0x64cdAA89629fe003eAa31B480d8b63372D109A53',
  });
  assert.match(output, /Lower scalar \(inclusive\): 10/);
  assert.match(output, /Upper scalar \(inclusive\): 20/);
  assert.match(output, /Private scalar \(decimal\): 15/);
  assert.match(output, new RegExp(`Private key \\(32-byte hex\\): 0x${'0'.repeat(63)}f`));
  assert.match(output, /Address: 0x64cdAA89629fe003eAa31B480d8b63372D109A53/);
  assert.match(output, /can be brute-forced/);
  assert.match(output, /Generated locally in the browser/);
});
