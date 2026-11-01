import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { parsePublicKeyFile, searchPublicKeys, validatePointSearchRange, MAX_PRIVATE_SCALAR } from '../src/public-key-search.js';

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
  assert.equal(validatePointSearchRange('1', '100000000').count, 100_000_000n);
  assert.equal(validatePointSearchRange('1', '100000001').count, 100_000_001n);
  assert.equal(validatePointSearchRange('1', MAX_PRIVATE_SCALAR.toString()).end, MAX_PRIVATE_SCALAR);
  assert.throws(() => validatePointSearchRange('1', (MAX_PRIVATE_SCALAR + 1n).toString()), /order minus one/);
  assert.equal(validatePointSearchRange('1000001', '101000000').count, 100_000_000n);
  assert.throws(() => validatePointSearchRange('0', '1'));
});


test('search finds a scalar beyond the initial million', async () => {
  const targets = parsePublicKeyFile([header, row(1000003)].join('\n'));
  const result = await searchPublicKeys(targets, validatePointSearchRange('1000001', '1000010'));
  assert.equal(result.status, 'done');
  assert.deepEqual(result.matches.map((match) => match.scalar), ['1000003']);
});

test('chunks cover boundaries and keep matches across chunks', async () => {
  const targets = parsePublicKeyFile([header, row(4), row(5), row(9), row(12)].join('\n'));
  const result = await searchPublicKeys(targets, validatePointSearchRange('1', '12'), { chunkSize: 4n, batchSize: 2 });
  assert.equal(result.status, 'done');
  assert.equal(result.completedChunks, 3n);
  assert.equal(result.completed, result.total);
  assert.deepEqual(result.matches.map((m) => m.scalar).sort((a,b) => Number(a)-Number(b)), ['4', '5', '9', '12']);
});

test('full scalar range remains precise and can be stopped after a small chunk', async () => {
  const targets = parsePublicKeyFile([header, row(3)].join('\n'));
  let stop = false;
  const result = await searchPublicKeys(targets, validatePointSearchRange('1', MAX_PRIVATE_SCALAR.toString()), {
    chunkSize: 4n, shouldStop: () => stop,
    onProgress: ({ completed }) => { if (completed >= 3n) stop = true; },
  });
  assert.equal(result.status, 'cancelled');
  assert.ok(result.completed < result.total);
  assert.equal(result.completedChunks, 1n);
  assert.equal(result.matches[0].scalar, '3');
});

test('range near secp256k1 order finds endpoint', async () => {
  const targets = parsePublicKeyFile([header, row(MAX_PRIVATE_SCALAR)].join('\n'));
  const result = await searchPublicKeys(targets, validatePointSearchRange((MAX_PRIVATE_SCALAR - 4n).toString(), MAX_PRIVATE_SCALAR.toString()), { chunkSize: 3n });
  assert.equal(result.status, 'done');
  assert.equal(result.matches[0].scalar, MAX_PRIVATE_SCALAR.toString());
});

test('collision key distinguishes opposite curve points and reports compressed collision', async () => {
  const targets = parsePublicKeyFile([header, row(8), row(MAX_PRIVATE_SCALAR)].join('\n'));
  const result = await searchPublicKeys(targets, validatePointSearchRange('1', '9'));
  assert.deepEqual(result.matches.map((m) => m.scalar), ['8']);
  assert.equal(result.matches[0].collisionPoint, '0x' + Buffer.from(secp256k1.Point.BASE.toBytes(true)).toString('hex'));
});

test('long searches yield to asynchronous stop requests', async () => {
  const targets = Array.from({ length: 256 }, (_, i) => ({ point: secp256k1.Point.BASE.multiply(BigInt(i + 1000001)), address: 'test' }));
  let stopped = false;
  setTimeout(() => { stopped = true; }, 0);
  const result = await searchPublicKeys(targets, validatePointSearchRange('1', '100000'), { shouldStop: () => stopped });
  assert.equal(result.status, 'cancelled');
  assert.ok(result.completed > 0n && result.completed < result.total);
});
