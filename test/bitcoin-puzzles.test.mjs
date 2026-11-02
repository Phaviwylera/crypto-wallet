import test from 'node:test';
import assert from 'node:assert/strict';
import { base58 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { BITCOIN_PUZZLES, BITCOIN_PUZZLE_SOURCE, bitcoinPuzzleCatalogTsv, getBitcoinPuzzle, getBitcoinPuzzleByAddress } from '../src/bitcoin-puzzles.js';
import { bitcoinPuzzlePointSearchText, createBitcoinPuzzleMatchExport } from '../src/bitcoin-puzzle-match.js';
import { bitcoinAddressForKey } from '../src/bitcoin-public-key.js';
import { parsePublicKeyFile, searchPublicKeys } from '../src/public-key-search.js';

test('catalog has 160 ordered puzzles with exact inclusive bit ranges and valid P2PKH addresses', () => {
  assert.equal(BITCOIN_PUZZLES.length, 160);
  assert.equal(BITCOIN_PUZZLES.filter((p) => p.status === 'solved').length, 83);
  assert.equal(BITCOIN_PUZZLES.filter((p) => p.status === 'unsolved').length, 77);
  for (const puzzle of BITCOIN_PUZZLES) {
    assert.equal(puzzle.id, BITCOIN_PUZZLES.indexOf(puzzle) + 1);
    assert.equal(puzzle.lower, (1n << BigInt(puzzle.id - 1)).toString());
    assert.equal(puzzle.upper, ((1n << BigInt(puzzle.id)) - 1n).toString());
    const decoded = base58.decode(puzzle.address);
    assert.equal(decoded.length, 25);
    assert.equal(decoded[0], 0);
    assert.equal(bytesToHex(decoded.slice(21)), bytesToHex(sha256(sha256(decoded.slice(0, 21))).slice(0, 4)));
    if (puzzle.publicKey) assert.equal(bitcoinAddressForKey(puzzle.publicKey, 'p2pkh'), puzzle.address);
  }
});

test('snapshot preserves significant puzzle rows and does not invent public keys', () => {
  const p71 = getBitcoinPuzzle(71);
  assert.equal(p71.address, '1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU');
  assert.equal(p71.lower, '1180591620717411303424');
  assert.equal(p71.upper, '2361183241434822606847');
  assert.equal(p71.publicKey, null);
  assert.equal(getBitcoinPuzzleByAddress(p71.address), p71);
  assert.equal(getBitcoinPuzzle(135).status, 'solved');
  assert.deepEqual(BITCOIN_PUZZLES.filter((p) => p.status === 'unsolved' && p.publicKey).map((p) => p.id), [140, 145, 150, 155, 160]);
  assert.equal(BITCOIN_PUZZLE_SOURCE.commit, '6bbd33dcefe2b4d039f96f437e86ea5f918de495');
  assert.throws(() => getBitcoinPuzzle(0), /1 through 160/);
  assert.throws(() => getBitcoinPuzzle(161), /1 through 160/);
});

test('public catalog export contains metadata and public fields but no private-key column', () => {
  const text = bitcoinPuzzleCatalogTsv();
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 163); // Two comments, one header and 160 records.
  assert.match(lines[0], /^# roadhero\/Bitcoin-Puzzle-info/);
  assert.match(lines[2], /lower_scalar_decimal/);
  assert.doesNotMatch(lines[2], /private/i);
  assert.equal(lines[3].split('\t')[0], '1');
  assert.equal(lines.at(-1).split('\t')[0], '160');
});

test('published catalog points load into the existing validator and BSGS without a fake transaction hash', async () => {
  const text = bitcoinPuzzlePointSearchText(1);
  assert.match(text, /\tpublished-catalog\t/);
  const targets = parsePublicKeyFile(text);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].transactionHash, 'published-catalog');
  const result = await searchPublicKeys(targets, { start: 1n, end: 1n, count: 1n });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].scalar, '1');
  const p140 = parsePublicKeyFile(bitcoinPuzzlePointSearchText(140));
  assert.equal(p140[0].address, getBitcoinPuzzle(140).address);
  assert.throws(() => bitcoinPuzzlePointSearchText(71), /no public key/);
});

test('match export independently verifies scalar, point, address and published bounds', () => {
  const puzzle = getBitcoinPuzzle(1);
  const output = createBitcoinPuzzleMatchExport({ puzzleId: 1, scalar: 1n, publicKey: `0x${puzzle.publicKey}`, address: puzzle.address });
  assert.match(output, /private_scalar_decimal: 1/);
  assert.match(output, /private_key_hex_32_bytes: 0{63}1/);
  assert.match(output, /No balance or spendable funds were checked/);
  assert.throws(() => createBitcoinPuzzleMatchExport({ puzzleId: 2, scalar: 1n, publicKey: `0x${getBitcoinPuzzle(2).publicKey}`, address: getBitcoinPuzzle(2).address }), /outside the published/);
  assert.throws(() => createBitcoinPuzzleMatchExport({ puzzleId: 2, scalar: 3n, publicKey: `0x${puzzle.publicKey}`, address: getBitcoinPuzzle(2).address }), /scalar × G/);
  assert.throws(() => createBitcoinPuzzleMatchExport({ puzzleId: 1, scalar: 1n, publicKey: `0x${puzzle.publicKey}`, address: getBitcoinPuzzle(2).address }), /result address/);
});
