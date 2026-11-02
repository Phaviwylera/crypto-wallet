import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ADDRESS_BATCH_TARGETS, MAX_BATCH_FILE_BYTES, MAX_RECOVERY_BATCH_ROWS, parseAddressBatch, parseRecoveryBatch, publicKeyResultsTsv } from '../src/batch-files.js';

const eth = (value) => /^0x[0-9a-fA-F]{40}$/.test(value)
  ? { valid: true, display: value, normalized: value.toLowerCase() }
  : { valid: false, reason: 'invalid Ethereum address' };
const other = (value) => /^(?:1|3|bc1|tb1|T)[a-zA-Z0-9]+$/.test(value)
  ? { valid: true, display: value, normalized: value }
  : { valid: false, reason: 'invalid address for selected network' };
const A = `0x${'aa'.repeat(20)}`;
const B = `0x${'bb'.repeat(20)}`;
const TX1 = `0x${'11'.repeat(32)}`;
const TX2 = `0x${'22'.repeat(32)}`;

test('batch limits are explicit', () => {
  assert.equal(MAX_BATCH_FILE_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_ADDRESS_BATCH_TARGETS, 10_000);
  assert.equal(MAX_RECOVERY_BATCH_ROWS, 1_000);
});

test('address batches accept common separators, comments, headers and normalized deduplication', () => {
  const parsed = parseAddressBatch(`# targets\naddress\n${A}\n${A.toUpperCase().replace('0X', '0x')}, ${B}\n${A};${B}\t${A}`, eth);
  assert.deepEqual(parsed.addresses, [A, B]);
  assert.deepEqual(parsed.transactions, []);
  const base58 = parseAddressBatch('1Aa\n1Aa,1AA\n3Bb;bc1qxyz', other);
  assert.deepEqual(base58.addresses, ['1Aa', '1AA', '3Bb', 'bc1qxyz']);
});

test('Ethereum address batches retain outgoing transaction pairs for extraction', () => {
  const parsed = parseAddressBatch(`address,tx_hash\n${A},${TX1}\n${A}\t${TX1}\n${B};${TX2}\n${A}`, eth, { ethereumTransactions: true });
  assert.deepEqual(parsed.addresses, [A, B]);
  assert.deepEqual(parsed.transactions, [{ address: A, txHash: TX1 }, { address: B, txHash: TX2 }]);
});

test('address batches report line errors and enforce target limits', () => {
  assert.throws(() => parseAddressBatch(`${A}\nnot-an-address`, eth), /Line 2: invalid Ethereum address/);
  assert.throws(() => parseAddressBatch('1Aa,1Bb\n1Cc', other, { maxTargets: 2 }), /at most 2/);
  assert.throws(() => parseAddressBatch('# empty\naddress', eth), /no addresses/);
});

test('Ethereum recovery batches require one outgoing transaction per address', () => {
  const parsed = parseRecoveryBatch(`address,tx_hash\n${A},${TX1}\n${A}\t${TX1}\n${B};${TX2}`, 'ethereum', eth);
  assert.deepEqual(parsed, [{ address: A, txHash: TX1 }, { address: B, txHash: TX2 }]);
  assert.throws(() => parseRecoveryBatch(A, 'ethereum', eth), /expected one Ethereum address and outgoing transaction hash/);
  assert.throws(() => parseRecoveryBatch(`${A},${TX1.slice(0, -1)}`, 'ethereum', eth), /Line 1/);
});

test('Bitcoin recovery batches accept one address per row and reject extra columns', () => {
  const parsed = parseRecoveryBatch('address\n1Aa\n1Aa\nbc1qxyz', 'bitcoin', other);
  assert.deepEqual(parsed, [{ address: '1Aa', txHash: '' }, { address: 'bc1qxyz', txHash: '' }]);
  assert.throws(() => parseRecoveryBatch('1Aa,3Bb', 'bitcoin', other), /expected one Bitcoin address/);
  assert.throws(() => parseRecoveryBatch('1Aa\ninvalid', 'bitcoin', other), /Line 2: invalid address/);
  assert.throws(() => parseRecoveryBatch('1Aa', 'ethereum', eth), /expected one Ethereum/);
});

test('recovery batches enforce row limits and reject unsupported networks', () => {
  assert.throws(() => parseRecoveryBatch('1Aa\n1Bb\n1Cc', 'bitcoin', other, { maxRows: 2 }), /at most 2/);
  assert.throws(() => parseRecoveryBatch('1Aa', 'tron', other), /Unsupported recovery batch network/);
});

test('public-key result TXT preserves per-row errors and can filter BSGS-ready rows', () => {
  const rows = [
    { address: A, txHash: TX1, publicKey: `0x04${'ab'.repeat(64)}`, status: 'ok' },
    { address: B, txHash: TX2, publicKey: '', status: 'provider\nfailed\tpolitely' },
  ];
  const all = publicKeyResultsTsv(rows);
  assert.match(all, /provider failed politely/);
  assert.equal(all.trim().split('\n').length, 3);
  const successful = publicKeyResultsTsv(rows, { successfulOnly: true });
  assert.match(successful, /0x04/);
  assert.doesNotMatch(successful, new RegExp(B));
  assert.equal(parseAddressBatch(`${A}\n${B}`, eth).addresses.length, 2);
  assert.throws(() => publicKeyResultsTsv([rows[1]], { successfulOnly: true }), /No successfully recovered/);
});
