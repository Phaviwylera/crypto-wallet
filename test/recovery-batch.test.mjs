import test from 'node:test';
import assert from 'node:assert/strict';
import { runRecoveryBatch } from '../src/recovery-batch.js';

const KEY = `0x04${'ab'.repeat(64)}`;
const rows = (count) => Array.from({ length: count }, (_, index) => ({ address: `address-${index}`, txHash: `tx-${index}` }));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('recovery batch preserves row order, successes and independent failures', async () => {
  const progress = [];
  const result = await runRecoveryBatch({
    entries: rows(4), concurrency: 3,
    recover: async (entry, index) => {
      await wait(4 - index);
      if (index === 1) throw new Error('provider failed');
      return { publicKey: KEY, txHash: `found-${index}`, type: 'test' };
    },
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(result.map((row) => row.address), rows(4).map((row) => row.address));
  assert.deepEqual(result.map((row) => row.status), ['ok', 'provider failed', 'ok', 'ok']);
  assert.equal(result[0].txHash, 'found-0');
  assert.equal(result[1].publicKey, '');
  assert.deepEqual(progress.at(-1), { completed: 4, succeeded: 3, total: 4, stopping: false });
});

test('recovery batch limits actual concurrency', async () => {
  let active = 0, maximum = 0;
  const result = await runRecoveryBatch({
    entries: rows(9), concurrency: 3,
    recover: async () => {
      active += 1; maximum = Math.max(maximum, active);
      await wait(4);
      active -= 1;
      return { publicKey: KEY };
    },
  });
  assert.equal(result.filter((row) => row.status === 'ok').length, 9);
  assert.equal(maximum, 3);
});

test('stop finishes in-flight work and marks all unstarted rows cancelled', async () => {
  let stopping = false, calls = 0;
  const result = await runRecoveryBatch({
    entries: rows(4), concurrency: 1,
    shouldStop: () => stopping,
    recover: async () => { calls += 1; await wait(2); return { publicKey: KEY }; },
    onProgress: ({ completed }) => { if (completed === 1) stopping = true; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.map((row) => row.status), ['ok', 'cancelled before processing', 'cancelled before processing', 'cancelled before processing']);
});

test('invalid recovery output becomes a row error instead of a false key success', async () => {
  const result = await runRecoveryBatch({ entries: rows(1), recover: async () => ({ publicKey: 'not-a-key' }) });
  assert.equal(result[0].status, 'Recovery did not return a valid uncompressed public key.');
  assert.equal(result[0].publicKey, '');
});

test('recovery batch validates its configuration', async () => {
  await assert.rejects(runRecoveryBatch({ entries: [], recover: async () => {} }), /at least one row/);
  await assert.rejects(runRecoveryBatch({ entries: rows(1), recover: async () => {}, concurrency: 0 }), /concurrency/);
  await assert.rejects(runRecoveryBatch({ entries: rows(1) }), /recovery function/);
});
