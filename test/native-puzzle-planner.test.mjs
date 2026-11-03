import test from 'node:test';
import assert from 'node:assert/strict';
import { getBitcoinPuzzle } from '../src/bitcoin-puzzles.js';
import { planNativePuzzleRange } from '../src/native-puzzle-planner.js';

const puzzle = getBitcoinPuzzle(71);
const base = BigInt(puzzle.lower);
const size = 10000000n;
const interval = (index) => ({ start: base + BigInt(index) * size, end: base + BigInt(index + 1) * size - 1n });
const completed = (index) => {
  const range = interval(index);
  return { puzzle: 71, campaign: `complete-${index}`, state: 'COMPLETED', found: false, lower: range.start.toString(), upper: range.end.toString(), done: size.toString(), total: size.toString() };
};

test('blank bounds default to the complete published interval when nothing was scanned', () => {
  const plan = planNativePuzzleRange(71, '', '', []);
  assert.equal(plan.automatic, true);
  assert.equal(plan.range.start, base);
  assert.equal(plan.range.end, BigInt(puzzle.upper));
  assert.equal(plan.adjusted, false);
});

test('automatic planning selects the first unscanned gap and merges completed coverage', () => {
  const plan = planNativePuzzleRange(71, '', '', [completed(2), completed(0), { ...completed(0) }]);
  assert.deepEqual(plan.range, { ...interval(1), count: size });
  assert.equal(plan.adjusted, true);
  const following = planNativePuzzleRange(71, '', '', [completed(0), completed(1), completed(2)]);
  assert.equal(following.range.start, interval(3).start);
  assert.equal(following.range.end, BigInt(puzzle.upper));
});

test('custom windows trim completed portions and reject fully covered windows', () => {
  const requestedEnd = interval(2).end;
  const plan = planNativePuzzleRange(71, base.toString(), requestedEnd.toString(), [completed(0), completed(2)]);
  assert.deepEqual(plan.range, { ...interval(1), count: size });
  assert.equal(plan.automatic, false);
  assert.throws(
    () => planNativePuzzleRange(71, base.toString(), requestedEnd.toString(), [completed(0), completed(1), completed(2)]),
    /already fully covered/,
  );
});

test('stopped and incomplete campaigns are never treated as contiguous scanned coverage', () => {
  const stopped = { ...completed(0), state: 'STOPPED', done: '5000000' };
  assert.throws(() => planNativePuzzleRange(71, '', '', [stopped]), /stopped count is not contiguous coverage/);
  const falseComplete = { ...completed(0), done: '1' };
  assert.throws(() => planNativePuzzleRange(71, '', '', [falseComplete]), /contiguous coverage/);
});

test('one blank bound uses the published bound and all input remains puzzle-scoped', () => {
  const plan = planNativePuzzleRange(71, interval(4).start.toString(), '', [completed(4)]);
  assert.equal(plan.range.start, interval(5).start);
  assert.equal(plan.range.end, BigInt(puzzle.upper));
  assert.throws(() => planNativePuzzleRange(71, '1', '', []), /outside puzzle #71/);
  const otherPuzzle = planNativePuzzleRange(1, '', '', [completed(0)]);
  assert.equal(otherPuzzle.range.start, 1n);
  assert.equal(otherPuzzle.range.end, 1n);
});
