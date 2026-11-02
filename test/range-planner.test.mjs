import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeForBitLength, planRange } from '../src/range-planner.js';
import { MAX_SEARCH_SCALAR } from '../src/search-range.js';

test('bit-length bounds are inclusive and respect the curve order', () => {
  assert.deepEqual(rangeForBitLength('1'), { start: 1n, end: 1n });
  assert.deepEqual(rangeForBitLength('20'), { start: 524288n, end: 1048575n });
  assert.deepEqual(rangeForBitLength('256'), { start: 1n << 255n, end: MAX_SEARCH_SCALAR });
  for (const value of ['', '0', '257', '1.5', '-1']) assert.throws(() => rangeForBitLength(value));
});
test('planner calculates inclusive coverage, actual chunked work, and optional rate', () => {
  const plan = planRange('1', '1000000', '2', '1000');
  assert.equal(plan.count, 1000000n); assert.equal(plan.chunks, 1n);
  assert.equal(plan.work, 2000n); assert.equal(plan.seconds, 2);
  assert.ok(plan.fraction > 0 && plan.fraction < 1);
  const full = planRange('1', MAX_SEARCH_SCALAR.toString(), '1');
  assert.equal(full.fraction, 1); assert.equal(full.seconds, null);
  const partial = planRange('1', '100000001', '1');
  assert.equal(partial.chunks, 2n); assert.equal(partial.work, 10001n);
});
test('planner rejects invalid bounds, counts and rates', () => {
  for (const [a,b,c,d] of [['0','1','1',''], ['2','1','1',''], ['1','2','0',''], ['1','2','10001',''], ['1','2','1','0'], ['1','2','1','Infinity']]) assert.throws(() => planRange(a,b,c,d));
});
