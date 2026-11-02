import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { bitcoinAddressForKey } from './bitcoin-public-key.js';
import { BITCOIN_PUZZLE_SOURCE, getBitcoinPuzzle } from './bitcoin-puzzles.js';

function uncompressedPoint(publicKey) {
  if (typeof publicKey !== 'string' || !/^0x(?:0[23][0-9a-f]{64}|04[0-9a-f]{128})$/i.test(publicKey)) {
    throw new Error('A valid compressed or uncompressed public key is required.');
  }
  return secp256k1.Point.fromBytes(hexToBytes(publicKey.slice(2)));
}

// Adapts a published catalog point to the existing public-key-search format.
// The source marker explicitly says that no transaction hash is being claimed.
export function bitcoinPuzzlePointSearchText(id) {
  const puzzle = getBitcoinPuzzle(id);
  if (!puzzle.publicKey) throw new Error(`Bitcoin puzzle #${puzzle.id} has no public key in this catalog snapshot.`);
  const point = uncompressedPoint(`0x${puzzle.publicKey}`);
  return `address\ttransaction_hash\tpublic_key_uncompressed\tstatus\n${puzzle.address}\tpublished-catalog\t0x${bytesToHex(point.toBytes(false))}\tok\n`;
}

// Export only a scalar that independently reproduces the selected public puzzle.
// This deliberately does not enumerate candidate keys or query wallet balances.
export function createBitcoinPuzzleMatchExport({ puzzleId, scalar, publicKey, address }) {
  const puzzle = getBitcoinPuzzle(puzzleId);
  let value;
  try { value = BigInt(scalar); }
  catch { throw new Error('The matching scalar is not a whole number.'); }
  if (value < BigInt(puzzle.lower) || value > BigInt(puzzle.upper)) throw new Error('The scalar is outside the published puzzle bounds.');
  if (address !== puzzle.address) throw new Error('The result address does not match the selected puzzle.');

  const point = uncompressedPoint(publicKey);
  const derivedPoint = secp256k1.Point.BASE.multiply(value);
  if (!derivedPoint.equals(point)) throw new Error('Verification failed: scalar × G does not equal the supplied public key.');
  if (bitcoinAddressForKey(derivedPoint.toBytes(true), 'p2pkh') !== puzzle.address) {
    throw new Error('Verification failed: the derived P2PKH address does not match the puzzle.');
  }

  const uncompressed = `0x${bytesToHex(derivedPoint.toBytes(false))}`;
  return [
    'BITCOIN PUZZLE · VERIFIED MATCH',
    `puzzle: #${puzzle.id}`,
    `address: ${puzzle.address}`,
    `private_scalar_decimal: ${value.toString()}`,
    `private_key_hex_32_bytes: ${value.toString(16).padStart(64, '0')}`,
    `public_key_uncompressed: ${uncompressed}`,
    `published_range_decimal: ${puzzle.lower}–${puzzle.upper}`,
    `catalog_status_snapshot: ${puzzle.status} as of source commit ${BITCOIN_PUZZLE_SOURCE.commitDate}; not live status`,
    'verification: scalar × G matches the supplied point; compressed P2PKH derivation matches the puzzle address',
    `source: ${BITCOIN_PUZZLE_SOURCE.url}`,
    '',
    'No balance or spendable funds were checked. This file contains private-key material; store it securely and do not share it.',
    '',
  ].join('\n');
}
