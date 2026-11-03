import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNativeHuntArgs, nativeCampaignName, validateNativePuzzleRange } from '../scripts/native-puzzle-api.mjs';
import { createNativePuzzleState, firstNativePuzzleChunk, formatNativePuzzleProgress, nativePuzzleProgressPercent, nativePuzzleRequest, nativePuzzleStatusMarkup, nextNativePuzzleChunk } from '../src/native-puzzle.js';

test('native puzzle chunks are inclusive, contiguous and keep their size', () => {
  const first = firstNativePuzzleChunk(71);
  assert.deepEqual(first, { lower: '1180591620717411303424', upper: '1180591620717421303423' });
  const next = nextNativePuzzleChunk(71, first.lower, first.upper);
  assert.deepEqual(next, { lower: '1180591620717421303424', upper: '1180591620717431303423' });
  assert.equal(BigInt(next.upper) - BigInt(next.lower) + 1n, 10000000n);
  assert.equal(firstNativePuzzleChunk(1).upper, '1');
  assert.equal(createNativePuzzleState().puzzleId, 71);
  assert.equal(createNativePuzzleState().lower, '');
  assert.equal(createNativePuzzleState().upper, '');
});

test('native ranges cannot escape the selected public puzzle bounds', () => {
  const { puzzle, range } = validateNativePuzzleRange(71, '1180591620717411303424', '1180591620717421303423');
  assert.equal(puzzle.address, '1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU');
  assert.equal(range.count, 10000000n);
  assert.throws(() => validateNativePuzzleRange(71, '1', '10'), /outside puzzle #71/);
  assert.throws(() => validateNativePuzzleRange(71, '1180591620717411303424', '2361183241434822606848'), /outside puzzle #71/);
  assert.throws(() => nextNativePuzzleChunk(71, '1', '10'), /outside puzzle #71/);
});

test('native hunt arguments preserve exact hex ranges and resume identity', () => {
  const { puzzle, range } = validateNativePuzzleRange(71, '1180591620717411303424', '1180591620717421303423');
  const campaign = nativeCampaignName(puzzle.id, range);
  assert.equal(campaign, nativeCampaignName(puzzle.id, range));
  const job = { puzzle: 71, lower: range.start.toString(), upper: range.end.toString(), threads: 2, campaign };
  const args = buildNativeHuntArgs(job, false);
  assert.ok(args.includes('400000000000000000:40000000000098967f'));
  assert.ok(args.includes('--no-gpu'));
  assert.ok(args.includes('--new'));
  assert.ok(!args.includes('--resume'));
  assert.ok(buildNativeHuntArgs(job, true).includes('--resume'));
  assert.equal(nativeCampaignName(71, { start: range.start + 1n, end: range.end }) === campaign, false);
});

test('native API requests attach a bearer token only for an authenticated control', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await nativePuzzleRequest('status');
    await nativePuzzleRequest('start', { method: 'POST', body: { puzzle: 2 }, accessToken: 'test-token' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[1].options.headers.authorization, 'Bearer test-token');
  assert.equal(calls[1].options.headers['content-type'], 'application/json');
});

test('native progress preserves tiny nonzero fractions instead of truncating them to zero', () => {
  const percent = nativePuzzleProgressPercent({ done: '175675768832', total: (2n ** 70n).toString() });
  assert.ok(percent > 0);
  assert.ok(Math.abs(percent - 1.488031642349e-8) < 1e-20);
  assert.equal(formatNativePuzzleProgress(percent), '1.49e-8%');
  assert.equal(formatNativePuzzleProgress(0.012345), '0.0123%');
  assert.equal(formatNativePuzzleProgress(0), '0.0000%');
});

test('native status markup reports results without exposing FOUND.txt contents', () => {
  const text = nativePuzzleStatusMarkup({
    loading: false,
    runner: { available: true, version: 'pzsolve 1.21.0', reason: '' },
    error: '<script>alert(1)</script>',
    jobs: [{ campaign: 'p71-0123456789abcdef', puzzle: 71, lower: '1', upper: '2', state: 'FOUND', done: '1', total: '2', found: true }],
  });
  assert.match(text, /Retrieve FOUND.txt/);
  assert.match(text, /not exposed through this API/);
  assert.doesNotMatch(text, /<script>/);
  assert.match(text, /&lt;script&gt;/);
});
