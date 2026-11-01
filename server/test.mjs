// Local correctness test for the server-side scan engine.
// Anchor vector: private key 0x00..01 -> Ethereum address 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
import { classifyInput, deriveSecret } from './lib/networks.mjs';
import { parseWalletFile } from './lib/parse.mjs';
import { MemoryStore } from './lib/store.mjs';
import { runScan } from './lib/scan.mjs';

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  - ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL- ${msg}`);
  }
}

const pk1 = '0x' + '0'.repeat(63) + '1';
const r1 = deriveSecret(classifyInput(pk1));
assert(r1.valid === true, 'private key 1 classified and derived');
assert(
  r1.addresses.ethereum.toLowerCase() === '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
  `ETH address from private key 1 matches known vector (got ${r1.addresses.ethereum})`,
);
assert(r1.addresses.bitcoin.startsWith('bc1q'), 'BTC native segwit address derived');
assert(r1.addresses.bitcoinTaproot.startsWith('bc1p'), 'BTC taproot address derived');
assert(r1.addresses.tron.startsWith('T'), 'TRON address derived');

// Mnemonic path
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const r2 = deriveSecret(classifyInput(mnemonic));
assert(r2.valid === true, 'abandon mnemonic classified and derived');
assert(typeof r2.seed === 'string' && r2.seed.length === 128, 'mnemonic seed is 64 bytes hex');
assert(r2.addresses.ethereum.startsWith('0x'), 'mnemonic derives an ETH address');

// Unknown input
const r3 = deriveSecret(classifyInput('not-a-real-secret'));
assert(r3.valid === false, 'unknown string is flagged invalid');

// File parsing
const parsed = parseWalletFile('seeds.txt', `${pk1}\n# comment\n${mnemonic}\n\n`);
assert(parsed.length === 2 && parsed[0] === pk1 && parsed[1] === mnemonic, 'txt parser keeps secrets, drops blanks/comments');

// Full scan via store
const store = new MemoryStore();
const job = await runScan('test-job', [pk1, mnemonic, 'garbage'], store);
assert(job.status === 'done', 'scan completes with done status');
assert(job.results.length === 3, 'scan produced 3 results');
assert(job.results.filter((x) => x.valid).length === 2, '2 of 3 inputs were valid secrets');

if (failures) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll scan-engine tests passed.');
}
