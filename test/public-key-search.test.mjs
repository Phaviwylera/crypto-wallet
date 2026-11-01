import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { parsePublicKeyFile, searchPublicKeys, validatePointSearchRange } from '../src/public-key-search.js';

const header = 'address\ttransaction_hash\tpublic_key_uncompressed\tstatus';
function row(n) {
  const pub = secp256k1.Point.BASE.multiply(BigInt(n)).toBytes(false);
  const address = Buffer.from(keccak_256(pub.slice(1)).slice(12)).toString('hex');
  return `0x${address}\t0x${'01'.repeat(32)}\t0x${Buffer.from(pub).toString('hex')}\tok`;
}

test('parse validates keys, addresses, rows and statuses', () => {
  assert.equal(parsePublicKeyFile(`${header}\n${row(1)}\n${row(8)}\n`).length, 2);
  assert.throws(() => parsePublicKeyFile(`${header}\n${row(1).replace(/\tok$/, '\tfailed')}`), /Line 2/);
  assert.throws(() => parsePublicKeyFile(`${header}\n${row(1).replace(/^0x[0-9a-f]{40}/, '0x' + '00'.repeat(20))}`), /does not match/);
  assert.throws(() => parsePublicKeyFile(header), /No public-key rows/);
});

test('shared BSGS finds lower, upper, multiple targets and excludes out-of-range values', async () => {
  const targets = parsePublicKeyFile([header, row(10), row(11), row(17), row(19), row(20)].join('\n'));
  const result = await searchPublicKeys(targets, validatePointSearchRange('10', '19'), { batchSize: 2 });
  assert.equal(result.status, 'done');
  assert.deepEqual(result.matches.map((m) => m.scalar).sort((a,b) => Number(a)-Number(b)), ['10','11','17','19']);
  assert.equal(result.matches.find((m) => m.scalar === '10').collisionPoint, 'point at infinity');
  assert.equal(result.completed, result.total);
});

test('single value, cancellation and invalid ranges', async () => {
  const targets = parsePublicKeyFile([header, row(7), row(8)].join('\n'));
  const single = await searchPublicKeys(targets, validatePointSearchRange('7', '7'));
  assert.deepEqual(single.matches.map((m) => m.scalar), ['7']);
  let stop = false;
  const partial = await searchPublicKeys(targets, validatePointSearchRange('1', '100'), { batchSize: 1, shouldStop: () => stop, onProgress: () => { stop = true; } });
  assert.equal(partial.status, 'cancelled'); assert.ok(partial.completed < partial.total);
  assert.throws(() => validatePointSearchRange('1', '1000001'), /at most/);
  assert.throws(() => validatePointSearchRange('0', '1'));
});
