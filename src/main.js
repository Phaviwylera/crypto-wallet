import { HDKey } from '@scure/bip32';
import { base58, bech32 } from '@scure/base';
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import './style.css';

const app = document.querySelector('#app');
const NETWORKS = {
  ethereum: { label: 'Ethereum', shortLabel: 'ETH', family: 'evm', path: "m/44'/60'/0'/0/0", pathLabels: ['BIP-44 purpose', 'Ethereum coin type', 'account', 'external chain', 'address index'] },
  bitcoin: { label: 'Bitcoin · Native SegWit', shortLabel: 'BTC', family: 'bitcoin', path: "m/84'/0'/0'/0/0", pathLabels: ['BIP-84 purpose', 'Bitcoin coin type', 'account', 'receive chain', 'address index'] },
  tron: { label: 'TRON', shortLabel: 'TRX', family: 'tron', path: "m/44'/195'/0'/0/0", pathLabels: ['BIP-44 purpose', 'TRON coin type', 'account', 'external chain', 'address index'] },
  bnb: { label: 'BNB Smart Chain', shortLabel: 'BNB', family: 'evm', path: "m/44'/60'/0'/0/0", pathLabels: ['BIP-44 purpose', 'EVM coin type', 'account', 'external chain', 'address index'] },
};
let selectedNetworkId = 'ethereum';
const selectedNetwork = () => NETWORKS[selectedNetworkId];
let wallet = freshWallet();
let passphrase = '';
let copied = new Set();
let backwardOpen = false;
let discreteLogResult = null;
let labAddressInput = null;

function freshWallet() {
  return {
    stage: 0,
    entropy: null,
    entropyHash: null,
    entropyChecksum: '',
    wordChunks: [],
    phrase: '',
    bip39Salt: null,
    seed: null,
    master: null,
    masterHmacOutput: null,
    pathNodes: [],
    account: null,
    publicKey: null,
    keccakHash: null,
    addressBytes: null,
    eip55Hash: null,
    tronPayload: null,
    tronChecksum: null,
    btcHash160: null,
    compressedPublicKey: null,
    address: '',
  };
}

function hex(bytes) {
  return bytes ? bytesToHex(bytes) : '';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function spacedHex(bytes) {
  return hex(bytes).match(/.{1,8}/g)?.join(' ') ?? '';
}

function shortHex(bytes, head = 14, tail = 10) {
  const value = hex(bytes);
  return value.length > head + tail ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

function byteGrid(bytes, addressStart = -1) {
  return Array.from(bytes, (value, index) => `<span class="hash-byte ${index >= addressStart ? 'address-byte' : ''}"><small>${index.toString(16).padStart(2, '0')}</small><b>${value.toString(16).padStart(2, '0')}</b></span>`).join('');
}

function addressPlaceholder() {
  const family = selectedNetwork().family;
  return family === 'bitcoin' ? 'bc1q…' : family === 'tron' ? 'T…' : '0x…';
}

function addressInputHint() {
  const family = selectedNetwork().family;
  if (family === 'bitcoin') return 'Bitcoin mainnet native-SegWit P2WPKH only (bc1q…).';
  if (family === 'tron') return 'TRON mainnet Base58Check address (usually starts with T).';
  return '20-byte 0x-prefixed address; mixed-case Ethereum/BNB input must pass EIP-55.';
}

function networkAddressDetails(parsed, network) {
  if (network.family === 'bitcoin') {
    const scriptPubKey = new Uint8Array([0x00, 0x14, ...parsed.bytes]);
    return `<p>Witness version: <b>0</b> · HRP: <b>bc</b> · checksum: Bech32</p><p>Witness program / HASH160: <code>${hex(parsed.bytes)}</code></p><p>P2WPKH scriptPubKey: <code>${hex(scriptPubKey)}</code></p>`;
  }
  if (network.family === 'tron') {
    return `<p>Version + address payload: <code>${hex(parsed.payload)}</code></p><p>Base58Check checksum: <code>${hex(parsed.checksum)}</code> · verified</p>`;
  }
  return `<p>EIP-55 Keccak hash: <code>${hex(parsed.checksumHash)}</code></p>`;
}

function binary(bytes) {
  return Array.from(bytes, (value) => value.toString(2).padStart(8, '0')).join('');
}

function checksumAddress(lowerHex, checksumDigest) {
  const lower = lowerHex.toLowerCase();
  const hash = hex(checksumDigest ?? keccak_256(new TextEncoder().encode(lower)));
  const checksummed = Array.from(lower, (character, index) => {
    if (/[a-f]/.test(character) && parseInt(hash[index], 16) >= 8) return character.toUpperCase();
    return character;
  }).join('');
  return `0x${checksummed}`;
}

async function copyToClipboard(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Try the user-gesture fallback; this may vary by browser on plain HTTP.
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const success = document.execCommand('copy');
  field.remove();
  if (!success) throw new Error('Clipboard access was blocked');
}

function copyValue(key) {
  const values = {
    entropy: () => hex(wallet.entropy),
    entropyHash: () => hex(wallet.entropyHash),
    phrase: () => wallet.phrase,
    salt: () => hex(wallet.bip39Salt),
    seed: () => hex(wallet.seed),
    masterHmac: () => hex(wallet.masterHmacOutput),
    masterPrivate: () => hex(wallet.master?.privateKey),
    chainCode: () => hex(wallet.master?.chainCode),
    accountPrivate: () => hex(wallet.account?.privateKey),
    publicKey: () => hex(wallet.publicKey),
    compressedPublicKey: () => hex(wallet.compressedPublicKey),
    publicBody: () => hex(wallet.publicKey?.slice(1)),
    tronPayload: () => hex(wallet.tronPayload),
    btcHash160: () => hex(wallet.btcHash160),
    keccak: () => hex(wallet.keccakHash),
    addressBytes: () => hex(wallet.addressBytes),
    eip55Hash: () => hex(wallet.eip55Hash),
    address: () => wallet.address,
  };
  return values[key]?.() ?? '';
}

function copyButton(key, title = 'Copy') {
  return `<button class="copy-button" type="button" data-copy="${key}">${copied.has(key) ? 'Copied' : title}</button>`;
}

function stageBadge(step) {
  if (wallet.stage >= step) return '<span class="step-status complete">DONE</span>';
  if (wallet.stage + 1 === step) return '<span class="step-status ready">NEXT</span>';
  return '<span class="step-status">LOCKED</span>';
}

function stepCard({ number, title, caption, step, body, action }) {
  const unlocked = wallet.stage >= step - 1;
  return `<section class="step-card ${wallet.stage >= step ? 'is-complete' : ''} ${unlocked ? '' : 'is-locked'}">
    <div class="step-heading"><span class="step-number">${number}</span><div class="step-heading-copy"><h2>${title}</h2><p>${caption}</p></div>${stageBadge(step)}</div>
    ${unlocked ? body : '<p class="locked-note">Complete the previous step to reveal this calculation.</p>'}
    ${action && wallet.stage === step - 1 ? `<div class="step-action"><button class="action-button" data-run-step="${step}">${action}<span aria-hidden="true">↗</span></button></div>` : ''}
  </section>`;
}

function render() {
  const activeNetwork = selectedNetwork();
  const pathSegments = activeNetwork.path.slice(2).split('/');
  const entropyReady = wallet.stage >= 1;
  const words = entropyReady ? wallet.phrase.split(' ') : [];
  const wordGrid = words.map((word, index) => {
    const wordIndex = wordlist.indexOf(word);
    const bits = wallet.wordChunks[index] ?? '';
    return `<div class="mnemonic-word"><span>${String(index + 1).padStart(2, '0')}</span><b>${word}</b><small>${String(wordIndex).padStart(4, '0')} · ${bits}</small></div>`;
  }).join('');

  const entropyBody = entropyReady ? `
    <div class="value-row"><div><label>128-bit entropy · 16 bytes</label><code>${spacedHex(wallet.entropy)}</code></div>${copyButton('entropy')}</div>
    <div class="value-row"><div><label>SHA-256(entropy) · full 256-bit digest</label><code>${spacedHex(wallet.entropyHash)}</code></div>${copyButton('entropyHash')}</div>
    <div class="checksum-strip"><span class="mini-label">CHECKSUM BITS USED · FIRST 4 OF SHA-256</span><code>${wallet.entropyChecksum}</code><span class="checksum-explain">The other 252 hash bits are not part of the mnemonic.</span></div>
    <div class="mnemonic-grid">${wordGrid}</div>
    <p class="step-explanation">Concatenate 128 entropy bits + 4 checksum bits = 132 bits. Split into twelve 11-bit integers; each integer selects one word-list entry. The word indices preserve all 128 entropy bits; the checksum bits only detect mistakes.</p>` : `
    <p class="step-explanation">Generate 16 cryptographically random bytes. Hash them with SHA-256, take the first 4 hash bits as checksum, append them to entropy, and split into twelve 11-bit word-list indices.</p>
    <div class="empty-inline">No phrase or keys exist until you generate a demo wallet.</div>`;

  const phraseBody = entropyReady ? `
    <div class="phrase-title-row"><span class="mini-label">12-WORD BIP-39 MNEMONIC</span>${copyButton('phrase', 'Copy phrase')}</div>
    <div class="mnemonic-grid compact-words">${wordGrid}</div>
    <p class="step-explanation">The phrase is the human-readable encoding of the entropy plus checksum. It is not the 512-bit seed or any chain’s address.</p>` : '<p class="locked-note">The twelve-word phrase is produced from the entropy and checksum above.</p>';

  const seedBody = wallet.stage >= 2 ? `
    <div class="formula-line"><span>PBKDF2-HMAC-SHA512</span><span>2,048 rounds</span><span>output: 64 bytes</span></div>
    <p class="step-explanation">Input: NFKD-normalized mnemonic. Salt bytes: UTF-8 of <code>mnemonic</code> + NFKD(optional passphrase). PBKDF2 iterates HMAC-SHA512 2,048 times and emits 64 bytes. The output is deterministic, but it is not an encrypted copy of its inputs.</p>
    <div class="value-row"><div><label>Salt · UTF-8 bytes, shown as hex</label><code>${spacedHex(wallet.bip39Salt)}</code></div>${copyButton('salt')}</div>
    <div class="value-row"><div><label>512-bit BIP-39 seed · 64 bytes</label><code>${spacedHex(wallet.seed)}</code></div>${copyButton('seed', 'Copy seed')}</div>` : '<p class="locked-note">This runs PBKDF2-HMAC-SHA512 on the phrase. The result is seed material—not a private key.</p>';

  const masterBody = wallet.stage >= 3 ? `
    <p class="step-explanation">BIP-32 computes HMAC-SHA512 with key = UTF-8 <code>Bitcoin seed</code> and data = the 64-byte seed. The 64-byte digest is split in half: IL becomes the master private scalar; IR becomes the master chain code.</p>
    <div class="value-row"><div><label>HMAC-SHA512 output · IL || IR · 64 bytes</label><code>${spacedHex(wallet.masterHmacOutput)}</code></div>${copyButton('masterHmac')}</div>
    <div class="value-row"><div><label>Master private key · IL · first 32 bytes</label><code>${spacedHex(wallet.master.privateKey)}</code></div>${copyButton('masterPrivate')}</div>
    <div class="value-row"><div><label>Master chain code · IR · final 32 bytes</label><code>${spacedHex(wallet.master.chainCode)}</code></div>${copyButton('chainCode')}</div>
    <p class="step-explanation subtle">The 64-byte seed is the HMAC input; the new 32-byte private key and 32-byte chain code are the carried-forward BIP-32 master node. The digest is not reversible to its input.</p>` : '<p class="locked-note">BIP-32 turns the seed into a master private key and chain code using HMAC-SHA512.</p>';

  const accountBody = wallet.stage >= 4 ? `
    <div class="path-value"><span class="mini-label">${activeNetwork.label.toUpperCase()} DERIVATION PATH</span><code>${activeNetwork.path}</code></div>
    <div class="path-legend">${pathSegments.map((segment, index) => `<span><b>${segment.replaceAll("'", '′')}</b> ${activeNetwork.pathLabels[index]}</span>`).join('')}</div>
    <p class="step-explanation">BIP-32 walks the selected path one child at a time. Each node carries a new private key and chain code forward. Hardened levels (′) use private parent material; this path is a wallet convention and is not embedded in the final address.</p>
    <div class="path-node-list">${wallet.pathNodes.map((entry) => `<details class="path-node"><summary><span>${entry.fullPath}</span><small>${entry.hardened ? 'HARDENED' : 'NORMAL'} · index 0x${entry.childIndex.toString(16).padStart(8, '0')}</small></summary><div class="value-row"><div><label>Child private key</label><code>${spacedHex(entry.node.privateKey)}</code></div></div><div class="value-row"><div><label>Child chain code</label><code>${spacedHex(entry.node.chainCode)}</code></div></div><div class="value-row"><div><label>Child compressed public key</label><code>${spacedHex(entry.node.publicKey)}</code></div></div></details>`).join('')}</div>
    <div class="value-row"><div><label>Final ${activeNetwork.label} account private key</label><code>${spacedHex(wallet.account.privateKey)}</code></div>${copyButton('accountPrivate')}</div>
    <div class="value-row"><div><label>Uncompressed secp256k1 public key · 65 bytes</label><code>${spacedHex(wallet.publicKey)}</code></div>${copyButton('publicKey')}</div>
    ${activeNetwork.family === 'bitcoin' ? `<div class="value-row"><div><label>Compressed public key · 33 bytes (used for P2WPKH)</label><code>${spacedHex(wallet.compressedPublicKey)}</code></div>${copyButton('compressedPublicKey')}</div>` : ''}` : `<p class="locked-note">Derive the ${activeNetwork.label} account at <code>${activeNetwork.path}</code>, then compute its secp256k1 public key.</p>`;

  let addressBody;
  if (wallet.stage < 5) {
    addressBody = `<p class="locked-note">Derive the public key, then apply the ${activeNetwork.label} address encoding.</p>`;
  } else if (activeNetwork.family === 'bitcoin') {
    addressBody = `
      <p class="step-explanation">Bitcoin native SegWit P2WPKH uses the compressed secp256k1 public key. SHA-256 then RIPEMD-160 produces a 20-byte witness program. Bech32 encodes witness version 0, that program, and the mainnet human-readable prefix <code>bc</code>.</p>
      <div class="hash-block"><div class="hash-block-heading"><label>INPUT · COMPRESSED PUBLIC KEY · 33 BYTES</label>${copyButton('compressedPublicKey', 'Copy key')}</div><div class="hash-byte-grid">${byteGrid(wallet.compressedPublicKey)}</div></div>
      <div class="hash-params"><span>HASH STEP 1 <b>SHA-256</b></span><span>HASH STEP 2 <b>RIPEMD-160</b></span><span>WITNESS <b>v0 · 20 bytes</b></span><span>ENCODING <b>BECH32</b></span></div>
      <div class="value-row"><div><label>HASH160 witness program · 20 bytes</label><code>${spacedHex(wallet.btcHash160)}</code></div>${copyButton('addressBytes', 'Copy program')}</div>
      <div class="hash-byte-grid address-byte-grid">${byteGrid(wallet.btcHash160)}</div>
      <div class="address-output"><div><span class="mini-label">BITCOIN · NATIVE SEGWIT P2WPKH</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  } else if (activeNetwork.family === 'tron') {
    addressBody = `
      <p class="step-explanation">TRON uses the uncompressed public key body (X || Y), Keccak-256, and the final 20 digest bytes. It prepends mainnet version byte <code>41</code>, appends the first 4 bytes of double-SHA-256 as a Base58Check checksum, then encodes the 25-byte result in Base58.</p>
      <div class="hash-block"><div class="hash-block-heading"><label>INPUT · PUBLIC KEY BODY · 64 BYTES</label>${copyButton('publicBody', 'Copy input')}</div><div class="hash-byte-grid input-byte-grid">${byteGrid(wallet.publicKey.slice(1))}</div></div>
      <div class="hash-block"><div class="hash-block-heading"><label>KECCAK-256 · FULL DIGEST · 32 BYTES</label></div><div class="hash-byte-grid output-byte-grid">${byteGrid(wallet.keccakHash, 12)}</div></div>
      <div class="value-row"><div><label>Address payload · 0x41 || last 20 digest bytes · 21 bytes</label><code>${spacedHex(wallet.tronPayload)}</code></div>${copyButton('tronPayload')}</div>
      <div class="value-row"><div><label>Checksum · first 4 bytes of SHA256(SHA256(payload))</label><code>${spacedHex(wallet.tronChecksum)}</code></div></div>
      <div class="address-output"><div><span class="mini-label">TRON MAINNET · BASE58CHECK</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  } else {
    addressBody = `
      <p class="step-explanation">${activeNetwork.family === 'evm' && selectedNetworkId === 'bnb' ? 'BNB Smart Chain is EVM-compatible: it uses the same secp256k1 public key, Keccak-256 address construction, and BIP-44 coin type 60 as Ethereum. The address is identical on both networks; the chain selection tells you which network to use.' : 'Ethereum derives its address from the uncompressed public-key body (X || Y): Keccak-256, then the final 20 digest bytes, followed by EIP-55 display casing.'}</p>
      <div class="hash-block"><div class="hash-block-heading"><label>INPUT · PUBLIC KEY BODY · 64 BYTES · PREFIX 04 OMITTED</label>${copyButton('publicBody', 'Copy input')}</div><div class="hash-byte-grid input-byte-grid">${byteGrid(wallet.publicKey.slice(1))}</div></div>
      <div class="hash-params"><span>KECCAK RATE <b>136 bytes</b></span><span>CAPACITY <b>64 bytes</b></span><span>ROUNDS <b>24</b></span><span>OUTPUT <b>32 bytes</b></span></div>
      <div class="hash-block"><div class="hash-block-heading"><label>OUTPUT · FULL KECCAK-256 DIGEST · 32 BYTES</label>${copyButton('keccak', 'Copy hash')}</div><div class="hash-byte-grid output-byte-grid">${byteGrid(wallet.keccakHash, 12)}</div><p class="hash-footnote">Digest bytes 12–31 (highlighted) form the 20-byte address; the first 12 bytes are discarded. Ethereum/BNB use legacy Keccak padding, not standardized SHA3-256.</p></div>
      <div class="hash-block"><div class="hash-block-heading"><label>ADDRESS PAYLOAD · 20 RAW BYTES</label>${copyButton('addressBytes', 'Copy bytes')}</div><div class="hash-byte-grid address-byte-grid">${byteGrid(wallet.addressBytes)}</div></div>
      <div class="value-row"><div><label>EIP-55 hash · Keccak-256 of lowercase address text</label><code>${spacedHex(wallet.eip55Hash)}</code></div>${copyButton('eip55Hash')}</div>
      <div class="address-output"><div><span class="mini-label">${activeNetwork.shortLabel} ADDRESS · EIP-55</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  }

  const recoveredEntropy = wallet.stage >= 5 ? mnemonicToEntropy(wallet.phrase, wordlist) : null;
  const entropyRoundTripMatches = recoveredEntropy && hex(recoveredEntropy) === hex(wallet.entropy);
  const backwardPanel = wallet.stage >= 5 && backwardOpen ? `
    <section class="backward-panel">
      <div class="backward-heading"><div><span class="eyebrow">LIVE REVERSE TRACE</span><h3>What can—and cannot—be recovered?</h3></div><span class="live-example">THIS SESSION · REAL VALUES</span></div>
      <p class="backward-intro">Read from your generated address back toward entropy. The forward outputs are visible above; these rows show what each output still tells you about its input.</p>
      <div class="carry-strip"><span><b>Carried forward</b> deterministic relationships, checksums, and the chosen derivation path</span><span><b>Changed at each step</b> representation, key material, and finally a shortened hash</span></div>
      <div class="reverse-list">
        <article class="reverse-row blocked"><div class="reverse-step">06</div><div class="reverse-content"><div class="reverse-title"><strong>Address ← public key</strong><span class="recovery-tag no">NOT REVERSIBLE</span></div><div class="reverse-live"><label>Live address</label><code>${wallet.address}</code></div><p>${activeNetwork.family === 'bitcoin' ? 'Bitcoin hashes the compressed public key with HASH160 and encodes the witness program using Bech32; there is no inverse to recover the public key.' : activeNetwork.family === 'tron' ? 'TRON Keccak-hashes the public-key body, keeps 20 bytes, then adds a version and Base58Check checksum; this does not reveal the key.' : 'Keccak-256 hashes the public-key body and the address keeps only 20 digest bytes. There is no inverse formula to recover the public key from this value.'}</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">05</div><div class="reverse-content"><div class="reverse-title"><strong>Public key ← private key</strong><span class="recovery-tag no">NOT PRACTICAL</span></div><div class="reverse-live"><label>Live public key</label><code>${shortHex(wallet.publicKey, 18, 12)}</code></div><p>The public key is <code>Q = d × G</code> on secp256k1. Finding <code>d</code> from <code>Q</code> requires solving the elliptic-curve discrete-log problem.</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">04</div><div class="reverse-content"><div class="reverse-title"><strong>Child key ← master node + path</strong><span class="recovery-tag no">PATH MATTERS</span></div><div class="reverse-live"><label>Path used</label><code>${activeNetwork.path}</code><label class="second-live-label">Live child key</label><code>${shortHex(wallet.account.privateKey, 18, 12)}</code></div><p>BIP-32 derives a child using HMAC-SHA512 and the selected path. The address does not encode that path. A child key alone lacks the parent chain code; hardened levels (${pathSegments.filter((segment) => segment.endsWith("'")).map((segment) => segment.replace("'", '′')).join(', ')}) also block deriving ancestors.</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">03</div><div class="reverse-content"><div class="reverse-title"><strong>Master node ← BIP-39 seed</strong><span class="recovery-tag no">NOT PRACTICAL</span></div><div class="reverse-live"><label>Master private · IL</label><code>${shortHex(wallet.master.privateKey, 18, 12)}</code><label class="second-live-label">Master chain code · IR</label><code>${shortHex(wallet.master.chainCode, 18, 12)}</code></div><p>BIP-32 creates these with HMAC-SHA512 using the key <code>Bitcoin seed</code>. The master node is derived from the seed; it does not contain a reversible copy of it.</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">02</div><div class="reverse-content"><div class="reverse-title"><strong>Seed ← mnemonic + passphrase</strong><span class="recovery-tag no">CANDIDATES ONLY</span></div><div class="reverse-live"><label>Live seed · abbreviated</label><code>${shortHex(wallet.seed, 20, 12)}</code><label class="second-live-label">Passphrase used</label><code>${passphrase ? 'non-empty · hidden' : 'empty'}</code></div><p>PBKDF2-HMAC-SHA512 produces a 512-bit seed. It is not an encrypted copy of the words. You can test a guessed phrase and passphrase by running forward and comparing, but cannot extract the original from the seed.</p></div></article>
        <article class="reverse-row reversible"><div class="reverse-step">01</div><div class="reverse-content"><div class="reverse-title"><strong>Mnemonic → entropy</strong><span class="recovery-tag yes">REVERSIBLE</span></div><div class="reverse-live"><label>Live phrase</label><code>${wallet.phrase}</code><label class="second-live-label">Recovered entropy · matches original: ${entropyRoundTripMatches ? 'YES' : 'NO'}</label><code>${spacedHex(recoveredEntropy)}</code></div><p>This is the exception: the 12 word indices encode the 128 entropy bits plus a 4-bit checksum. BIP-39 can decode the phrase back to the exact entropy and verify its checksum.</p></div></article>
      </div>
      <div class="takeaway"><strong>Why address → phrase search is not practical</strong><span>With no phrase words known, a search must try up to 2<sup>128</sup> valid mnemonics (and know the passphrase and derivation path), derive each address, then compare. This is not a useful workload for the $85 EC2 budget.</span></div>
    </section>` : '';
  const discreteLogLab = wallet.stage >= 5 ? `
    <section class="backward-panel dlog-panel">
      <div class="backward-heading"><div><span class="eyebrow">ADDRESS SEARCH · LOCAL ONLY</span><h3>Test a ${activeNetwork.label} address</h3></div><span class="live-example">256 CANDIDATES MAX</span></div>
      <p class="backward-intro">Enter any address for the selected network. The lab generates actual secp256k1 public keys for scalars 1–256, derives each address using this network’s format, and compares them.</p>
      <div class="dlog-address-control"><label for="lab-address">${activeNetwork.label} address</label><input id="lab-address" type="text" spellcheck="false" autocomplete="off" placeholder="${addressPlaceholder()}" value="${escapeHtml(labAddressInput ?? wallet.address)}"><small>${addressInputHint()}</small></div>
      <div class="dlog-warning"><strong>This is a real but tiny bounded search—not a full secp256k1 break.</strong> An address does not reveal its public key or private key; only scalars 1–256 are tested. Everything runs in this browser.</div>
      <button class="action-button dlog-button" id="run-dlog-lab" type="button">${discreteLogResult ? 'Search this address again' : `Run 256-candidate ${activeNetwork.shortLabel} search`}<span aria-hidden="true">↗</span></button>
      ${discreteLogResult ? discreteLogResult.status === 'invalid' ? `<div class="dlog-warning result-error"><strong>Invalid ${activeNetwork.label} address.</strong> ${escapeHtml(discreteLogResult.reason)}</div>` : `<div class="dlog-results"><div><label>INPUT · ${activeNetwork.shortLabel} ADDRESS BYTES</label><code class="dlog-address-value">${escapeHtml(discreteLogResult.parsed.display)}</code><div class="hash-byte-grid address-byte-grid">${byteGrid(discreteLogResult.parsed.bytes)}</div>${networkAddressDetails(discreteLogResult.parsed, activeNetwork)}</div><div><label>SEARCH · REAL SECP256K1 CANDIDATES</label><p>${discreteLogResult.foundScalar ? `Match found at private scalar d=${discreteLogResult.foundScalar}; this candidate reproduces the entered address.` : `No match in scalars 1–${discreteLogResult.trials}, after ${discreteLogResult.trials} public-key/address derivations.`}</p><p>Only the tested interval is ruled out. The other valid private scalars were not searched.</p>${discreteLogResult.foundPublicKey ? `<p>Matched public key: <code class="dlog-address-value">${discreteLogResult.foundPublicKey}</code></p>` : '<p>The target public key cannot be recovered from this address alone.</p>'}</div><div><label>BOUNDARY CANDIDATES</label><p>d=1 → <code>${discreteLogResult.firstCandidateAddress}</code></p><p>d=${discreteLogResult.trials} → <code>${discreteLogResult.lastCandidateAddress}</code></p><p>These are real addresses computed under ${activeNetwork.label} rules.</p></div></div>` : '<p class="dlog-placeholder">Enter an address and run the bounded real-curve candidate test.</p>'}
      <p class="step-explanation subtle">For each candidate d, compute Q=dG on secp256k1, apply the selected network’s public-key/address encoding, then compare. A miss means only “not found in 1–256”—not “key impossible” or “curve broken.”</p>
    </section>` : '';

  app.innerHTML = `
    <header class="topbar"><a class="brand" href="#" aria-label="Seedlab home"><span class="brand-mark">S</span><span>seedlab</span></a><div class="topbar-meta"><span class="live-dot"></span> DERIVATION LAB <span class="topbar-divider">/</span> TEST DATA ONLY</div></header>
    <main class="page-shell">
      <div class="page-heading"><div><div class="eyebrow">WALLET BUILD · 5 CALCULATIONS</div><h1>Trace a wallet to its address.</h1><p>Run each calculation in order. Every value is generated in this browser session.</p></div><div class="session-chip"><span class="session-dot"></span>${wallet.stage ? `STEP ${String(Math.min(wallet.stage + 1, 5)).padStart(2, '0')} OF 05` : 'READY TO START'}</div></div>
      <div class="security-banner"><span class="alert-mark">!</span><p><strong>Public HTTP learning demo.</strong> Secret values stay in this browser; HTTP can be intercepted or altered. Never enter real wallet secrets. The optional TXT export is unencrypted and contains the phrase, passphrase, seed, and private keys; it requires confirmation.</p></div>
      <div class="layout-grid">
        <div class="lesson-column">
          <section class="setup-card"><div class="setup-copy"><span class="eyebrow">START HERE</span><h2>Make a fresh demo wallet</h2><p>Uses browser cryptographic randomness. Nothing is saved or sent to EC2.</p></div><div class="setup-controls"><label for="network-select">Derive an address for</label><select id="network-select">${Object.entries(NETWORKS).map(([id, network]) => `<option value="${id}" ${selectedNetworkId === id ? 'selected' : ''}>${network.label}</option>`).join('')}</select><small class="network-note">BTC: native SegWit · TRON: Base58Check · BNB Smart Chain uses the EVM address format.</small><label for="passphrase">Optional BIP-39 passphrase</label><input id="passphrase" type="password" autocomplete="new-password" placeholder="Leave blank for no passphrase" value="${passphrase.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}" ${wallet.stage ? 'disabled' : ''}><small>${wallet.stage ? 'Locked for this derivation; reset to change it.' : 'Case-sensitive. It creates a different wallet.'}</small><button class="action-button generate-button" id="generate">${wallet.stage ? 'Generate another demo wallet' : 'Generate demo wallet'}<span aria-hidden="true">↗</span></button></div></section>
          <div class="steps-heading"><div><span class="eyebrow">THE PIPELINE</span><h2>Five steps, one address</h2></div><div class="steps-actions">${wallet.stage >= 5 ? `<button class="export-button" id="export-txt">Export full TXT</button><button class="reverse-toggle" id="backward-toggle">${backwardOpen ? 'Hide backward trace' : 'Trace backward'}</button>` : ''}${wallet.stage ? '<button class="reset-button" id="reset">Reset session</button>' : ''}</div></div>
          ${stepCard({ number: '01', title: 'Entropy → mnemonic', caption: 'Create randomness and encode twelve words', step: 1, body: entropyBody, action: 'Generate 128-bit entropy & phrase' })}
          ${stepCard({ number: '02', title: 'Mnemonic → seed', caption: 'PBKDF2-HMAC-SHA512 · BIP-39', step: 2, body: seedBody, action: 'Derive 512-bit seed' })}
          ${stepCard({ number: '03', title: 'Seed → master node', caption: 'HMAC-SHA512 · BIP-32', step: 3, body: masterBody, action: 'Create BIP-32 master node' })}
          ${stepCard({ number: '04', title: `Master node → ${activeNetwork.label} keypair`, caption: `${activeNetwork.path.split('/')[1].replaceAll("'", '′')} path · secp256k1`, step: 4, body: accountBody, action: `Derive ${activeNetwork.label} account` })}
          ${stepCard({ number: '05', title: `${activeNetwork.label} public key → address`, caption: activeNetwork.family === 'bitcoin' ? 'SHA-256 · RIPEMD-160 · Bech32' : activeNetwork.family === 'tron' ? 'Keccak-256 · Base58Check' : 'Keccak-256 · last 20 bytes · EIP-55', step: 5, body: addressBody, action: `Compute ${activeNetwork.label} address` })}
          ${backwardPanel}
          ${discreteLogLab}
        </div>
        <aside class="side-rail">
          <section class="rail-card"><div class="rail-title"><span class="eyebrow">MAP</span><span class="rail-index">01—05</span></div><ol class="flow-list"><li class="${wallet.stage >= 1 ? 'visited' : ''}"><b>01</b><span>128-bit entropy</span></li><li class="${wallet.stage >= 1 ? 'visited' : ''}"><b>02</b><span>12 BIP-39 words</span></li><li class="${wallet.stage >= 2 ? 'visited' : ''}"><b>03</b><span>512-bit seed</span></li><li class="${wallet.stage >= 3 ? 'visited' : ''}"><b>04</b><span>BIP-32 master node</span></li><li class="${wallet.stage >= 4 ? 'visited' : ''}"><b>05</b><span>${activeNetwork.shortLabel} keypair</span></li><li class="${wallet.stage >= 5 ? 'visited current' : ''}"><b>↳</b><span>${activeNetwork.shortLabel} address</span></li></ol></section>
          <section class="rail-card path-card"><span class="eyebrow">${activeNetwork.shortLabel} PATH</span><code>${activeNetwork.path}</code><p>Switching networks selects a different derivation path or address encoding.</p></section>
          <section class="rail-card note-card"><span class="note-icon">i</span><div><strong>Keep the direction clear</strong><p>Each step derives new material from the prior value. The process does not provide a practical way to reverse a seed into its original phrase.</p></div></section>
          <div class="rail-foot">LOCAL SESSION <span>·</span> NO SERVER API</div>
        </aside>
      </div>
      <footer class="page-footer"><span>SEEDLAB <span class="footer-muted">· INTERACTIVE CRYPTOGRAPHY PRIMER</span></span><span>TEST VALUES ONLY · NEVER FOR FUNDS</span></footer>
    </main>`;

  const passInput = document.querySelector('#passphrase');
  passInput?.addEventListener('input', (event) => { passphrase = event.target.value; });
  document.querySelector('#network-select')?.addEventListener('change', selectNetwork);
  document.querySelector('#generate')?.addEventListener('click', generateWallet);
  document.querySelector('#reset')?.addEventListener('click', resetWallet);
  document.querySelector('#backward-toggle')?.addEventListener('click', () => {
    backwardOpen = !backwardOpen;
    render();
  });
  document.querySelector('#export-txt')?.addEventListener('click', exportDerivationTxt);
  document.querySelector('#run-dlog-lab')?.addEventListener('click', runDiscreteLogLab);
  document.querySelector('#lab-address')?.addEventListener('input', (event) => { labAddressInput = event.target.value; });
  document.querySelectorAll('[data-run-step]').forEach((button) => button.addEventListener('click', () => runStep(Number(button.dataset.runStep))));
  document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await copyToClipboard(copyValue(button.dataset.copy));
      copied.add(button.dataset.copy);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy unavailable';
    }
  }));
}

function selectNetwork(event) {
  selectedNetworkId = event.target.value;
  discreteLogResult = null;
  labAddressInput = null;
  copied = new Set();
  if (wallet.stage >= 4) {
    deriveAccountForNetwork();
    if (wallet.stage >= 5) deriveNetworkAddress();
  }
  render();
}

function generateWallet() {
  try {
    const passInput = document.querySelector('#passphrase');
    if (passInput) passphrase = passInput.value;
    const entropy = new Uint8Array(16);
    globalThis.crypto.getRandomValues(entropy);
    wipeWalletSecrets();
    wallet = freshWallet();
    backwardOpen = false;
    discreteLogResult = null;
    labAddressInput = null;
    wallet.entropy = entropy;
    wallet.entropyHash = sha256(entropy);
    wallet.entropyChecksum = binary(wallet.entropyHash).slice(0, 4);
    const mnemonicBits = binary(entropy) + wallet.entropyChecksum;
    wallet.wordChunks = Array.from({ length: 12 }, (_, index) => mnemonicBits.slice(index * 11, (index + 1) * 11));
    wallet.phrase = entropyToMnemonic(entropy, wordlist);
    wallet.stage = 1;
    copied = new Set();
    render();
  } catch {
    alert('Secure browser randomness is unavailable. Use HTTPS or localhost for browser cryptography.');
  }
}

function runStep(step) {
  try {
    if (step === 2 && wallet.stage === 1) {
      const normalizedPassphrase = passphrase.normalize('NFKD');
      wallet.bip39Salt = new TextEncoder().encode(`mnemonic${normalizedPassphrase}`);
      wallet.seed = mnemonicToSeedSync(wallet.phrase, passphrase);
    } else if (step === 3 && wallet.stage === 2) {
      wallet.master = HDKey.fromMasterSeed(wallet.seed);
      wallet.masterHmacOutput = new Uint8Array([...wallet.master.privateKey, ...wallet.master.chainCode]);
    } else if (step === 4 && wallet.stage === 3) {
      deriveAccountForNetwork();
    } else if (step === 5 && wallet.stage === 4) {
      deriveNetworkAddress();
    }
    wallet.stage = step;
    copied = new Set();
    render();
  } catch (error) {
    console.error(error);
    alert('That derivation step failed. Reset and try again in a modern browser.');
  }
}

function deriveAccountForNetwork() {
  wallet.pathNodes.forEach((entry) => entry.node?.wipePrivateData());
  wallet.account?.wipePrivateData();
  const segments = selectedNetwork().path.slice(2).split('/');
  wallet.pathNodes = segments.map((segment, index) => {
    const fullPath = `m/${segments.slice(0, index + 1).join('/')}`;
    const node = wallet.master.derive(fullPath);
    const value = Number(segment.replace("'", ''));
    const hardened = segment.endsWith("'");
    return { segment, fullPath, hardened, childIndex: value + (hardened ? 0x80000000 : 0), node };
  });
  wallet.account = wallet.pathNodes.at(-1).node;
  wallet.publicKey = secp256k1.getPublicKey(wallet.account.privateKey, false);
  wallet.compressedPublicKey = wallet.account.publicKey;
}

function addressFromPublicKeys(uncompressedPublicKey, compressedPublicKey, networkId = selectedNetworkId) {
  const network = NETWORKS[networkId];
  if (network.family === 'bitcoin') {
    const witnessProgram = ripemd160(sha256(compressedPublicKey));
    return bech32.encode('bc', [0, ...bech32.toWords(witnessProgram)]);
  }
  const keccakHash = keccak_256(uncompressedPublicKey.slice(1));
  const addressBytes = keccakHash.slice(12);
  if (network.family === 'tron') {
    const payload = new Uint8Array([0x41, ...addressBytes]);
    const checksum = sha256(sha256(payload)).slice(0, 4);
    return base58.encode(new Uint8Array([...payload, ...checksum]));
  }
  return checksumAddress(hex(addressBytes));
}

function parseNetworkAddress(input, networkId = selectedNetworkId) {
  const network = NETWORKS[networkId];
  if (network.family === 'evm') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(input)) return { valid: false, reason: 'Enter 0x followed by exactly 40 hexadecimal characters.' };
    const body = input.slice(2);
    const lower = body.toLowerCase();
    const mixed = body !== lower && body !== body.toUpperCase();
    const checksummed = checksumAddress(lower);
    if (mixed && checksummed !== input) return { valid: false, reason: 'Mixed-case address failed its EIP-55 checksum.' };
    return { valid: true, display: checksummed, normalized: `0x${lower}`, bytes: Uint8Array.from(lower.match(/.{2}/g), (byte) => Number.parseInt(byte, 16)), checksumHash: keccak_256(new TextEncoder().encode(lower)) };
  }
  if (network.family === 'tron') {
    try {
      const decoded = base58.decode(input);
      if (decoded.length !== 25) return { valid: false, reason: 'TRON mainnet Base58Check addresses decode to 25 bytes.' };
      const payload = decoded.slice(0, 21);
      const checksum = decoded.slice(21);
      const expected = sha256(sha256(payload)).slice(0, 4);
      if (payload[0] !== 0x41 || hex(checksum) !== hex(expected)) return { valid: false, reason: 'Invalid TRON mainnet prefix or Base58Check checksum.' };
      return { valid: true, display: input, normalized: input, bytes: payload.slice(1), payload, checksum };
    } catch {
      return { valid: false, reason: 'Enter a valid TRON mainnet Base58Check address (usually starts with T).' };
    }
  }
  try {
    const decoded = bech32.decode(input);
    const program = Uint8Array.from(bech32.fromWords(decoded.words.slice(1)));
    if (decoded.prefix !== 'bc' || decoded.words[0] !== 0 || program.length !== 20) return { valid: false, reason: 'Enter a Bitcoin mainnet native-SegWit P2WPKH address (bc1q… with a 20-byte witness program).' };
    const canonical = bech32.encode('bc', [0, ...bech32.toWords(program)]);
    return { valid: true, display: canonical, normalized: canonical.toLowerCase(), bytes: program };
  } catch {
    return { valid: false, reason: 'Enter a valid Bitcoin mainnet Bech32 P2WPKH address (bc1q…).'}
  }
}

function deriveNetworkAddress() {
  wallet.keccakHash = null;
  wallet.addressBytes = null;
  wallet.eip55Hash = null;
  wallet.tronPayload = null;
  wallet.tronChecksum = null;
  wallet.btcHash160 = null;

  if (selectedNetwork().family === 'bitcoin') {
    wallet.btcHash160 = ripemd160(sha256(wallet.compressedPublicKey));
    wallet.addressBytes = wallet.btcHash160;
    wallet.address = bech32.encode('bc', [0, ...bech32.toWords(wallet.btcHash160)]);
    return;
  }

  wallet.keccakHash = keccak_256(wallet.publicKey.slice(1));
  wallet.addressBytes = wallet.keccakHash.slice(12);
  const lowerAddress = hex(wallet.addressBytes);
  if (selectedNetwork().family === 'tron') {
    wallet.tronPayload = new Uint8Array([0x41, ...wallet.addressBytes]);
    wallet.tronChecksum = sha256(sha256(wallet.tronPayload)).slice(0, 4);
    wallet.address = base58.encode(new Uint8Array([...wallet.tronPayload, ...wallet.tronChecksum]));
    return;
  }

  wallet.eip55Hash = keccak_256(new TextEncoder().encode(lowerAddress));
  wallet.address = checksumAddress(lowerAddress, wallet.eip55Hash);
}

function smallScalarBytes(scalar) {
  const bytes = new Uint8Array(32);
  let value = BigInt(scalar);
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function runDiscreteLogLab() {
  const addressInput = document.querySelector('#lab-address')?.value.trim() ?? '';
  labAddressInput = addressInput;
  const parsed = parseNetworkAddress(addressInput);
  if (!parsed.valid) {
    discreteLogResult = { status: 'invalid', addressInput, reason: parsed.reason, networkId: selectedNetworkId };
    render();
    return;
  }

  const trials = 256;
  let firstCandidateAddress = '';
  let lastCandidateAddress = '';
  let foundScalar = null;
  let foundPublicKey = null;
  const family = selectedNetwork().family;
  const normalize = (address) => family === 'tron' ? address : address.toLowerCase();
  for (let candidate = 1; candidate <= trials; candidate += 1) {
    const privateKey = smallScalarBytes(candidate);
    const uncompressed = secp256k1.getPublicKey(privateKey, false);
    const compressed = secp256k1.getPublicKey(privateKey, true);
    const candidateAddress = addressFromPublicKeys(uncompressed, compressed);
    if (candidate === 1) firstCandidateAddress = candidateAddress;
    if (candidate === trials) lastCandidateAddress = candidateAddress;
    if (normalize(candidateAddress) === normalize(parsed.display)) {
      foundScalar = candidate;
      foundPublicKey = `0x${hex(uncompressed)}`;
    }
  }

  discreteLogResult = {
    status: 'valid',
    addressInput,
    networkId: selectedNetworkId,
    parsed,
    trials,
    firstCandidateAddress,
    lastCandidateAddress,
    foundScalar,
    foundPublicKey,
  };
  render();
}

function indexedBytes(bytes) {
  return Array.from(bytes, (value, index) => `${String(index).padStart(2, '0')}  0x${value.toString(16).padStart(2, '0')}`).join('\n');
}

function networkAddressExportLines() {
  const network = selectedNetwork();
  const common = [
    `Uncompressed secp256k1 public key (65 bytes): ${hex(wallet.publicKey)}`,
    `X coordinate (32 bytes): ${hex(wallet.publicKey.slice(1, 33))}`,
    `Y coordinate (32 bytes): ${hex(wallet.publicKey.slice(33, 65))}`,
  ];
  if (network.family === 'bitcoin') {
    const sha = sha256(wallet.compressedPublicKey);
    return [
      ...common,
      `Compressed public key (33 bytes): ${hex(wallet.compressedPublicKey)}`,
      `SHA-256(compressed public key): ${hex(sha)}`,
      `HASH160 = RIPEMD-160(SHA-256): ${hex(wallet.btcHash160)}`,
      'Native SegWit P2WPKH: witness version 0; mainnet HRP bc; Bech32 checksum.',
      `Witness program bytes: ${indexedBytes(wallet.btcHash160)}`,
      `Bitcoin address: ${wallet.address}`,
      `P2WPKH scriptPubKey: 0014${hex(wallet.btcHash160)}`,
    ];
  }
  if (network.family === 'tron') {
    return [
      ...common,
      `Keccak input (public-key body X || Y, 64 bytes): ${hex(wallet.publicKey.slice(1))}`,
      `Keccak-256 digest: ${hex(wallet.keccakHash)}`,
      `Address bytes (last 20 digest bytes): ${hex(wallet.addressBytes)}`,
      `TRON payload (0x41 || address bytes): ${hex(wallet.tronPayload)}`,
      `Base58Check checksum (first 4 bytes of double-SHA256): ${hex(wallet.tronChecksum)}`,
      `TRON mainnet Base58Check address: ${wallet.address}`,
    ];
  }
  return [
    ...common,
    `Keccak input (public-key body X || Y, 64 bytes): ${hex(wallet.publicKey.slice(1))}`,
    'Ethereum/BNB Smart Chain use legacy Keccak-256 padding (not SHA3-256).',
    `Full Keccak-256 digest: ${hex(wallet.keccakHash)}`,
    `Address payload (last 20 digest bytes): ${hex(wallet.addressBytes)}`,
    `EIP-55 checksum hash: ${hex(wallet.eip55Hash)}`,
    `${network.label} address: ${wallet.address}`,
  ];
}

function networkSearchExportLines() {
  const result = discreteLogResult;
  const network = NETWORKS[result?.networkId ?? selectedNetworkId];
  if (!result) return ['Not run during this session.'];
  if (result.status === 'invalid') return [`Invalid ${network.label} address: ${result.reason}`, 'No candidates were tested.'];
  const lines = [
    `Selected network: ${network.label}`,
    `Entered address: ${result.addressInput}`,
    `Canonical address: ${result.parsed.display}`,
    `Address bytes: ${hex(result.parsed.bytes)}`,
  ];
  if (network.family === 'evm') lines.push(`EIP-55 hash: ${hex(result.parsed.checksumHash)}`);
  if (network.family === 'tron') lines.push(`TRON payload: ${hex(result.parsed.payload)}`, `Base58Check checksum: ${hex(result.parsed.checksum)}`);
  if (network.family === 'bitcoin') lines.push(`P2WPKH witness program: ${hex(result.parsed.bytes)}`, `scriptPubKey: 0014${hex(result.parsed.bytes)}`);
  lines.push(`Algorithm: derive secp256k1 public keys for scalars 1..${result.trials}; encode each address using ${network.label} rules; compare with target.`);
  lines.push(result.foundScalar ? `Match found: private scalar d=${result.foundScalar}; uncompressed public key=${result.foundPublicKey}.` : `No match among scalars 1..${result.trials}. This does not test any other valid private scalars.`);
  lines.push(`Candidate d=1 address: ${result.firstCandidateAddress}`, `Candidate d=${result.trials} address: ${result.lastCandidateAddress}`);
  lines.push('The address does not reveal its public key or private scalar. No address or derivation value is sent to a server.');
  return lines;
}

function exportDerivationTxt() {
  const confirmed = window.confirm('This plain-text file contains the mnemonic, optional passphrase, seed, and private keys. It is not encrypted. Save it only for this educational demo and keep it private. Continue?');
  if (!confirmed) return;

  const entropyRoundTrip = mnemonicToEntropy(wallet.phrase, wordlist);
  const pathReport = wallet.pathNodes.map((entry, index) => [
    `PATH NODE ${index + 1}: ${entry.fullPath}`,
    `  segment: ${entry.segment} (${entry.hardened ? 'hardened' : 'normal'})`,
    `  child index: ${entry.childIndex} (0x${entry.childIndex.toString(16).padStart(8, '0')})`,
    `  depth: ${entry.node.depth}`,
    `  private key: ${hex(entry.node.privateKey)}`,
    `  chain code: ${hex(entry.node.chainCode)}`,
    `  compressed public key: ${hex(entry.node.publicKey)}`,
  ].join('\n')).join('\n\n');

  const report = [
    'SEEDLAB — FULL EDUCATIONAL WALLET DERIVATION',
    `Created locally: ${new Date().toISOString()}`,
    'WARNING: Unencrypted secret export. Demo values only; never use for real funds.',
    'All calculations were performed in this browser. This text file contains private wallet material.',
    '',
    'DERIVATION SETTINGS',
    `Selected network: ${selectedNetwork().label}`,
    `Derivation path: ${selectedNetwork().path}`,
    `BIP-39 passphrase (exact, JSON-escaped): ${JSON.stringify(passphrase)}`,
    '',
    'STEP 1 — ENTROPY → BIP-39 MNEMONIC',
    'Generate 16 bytes with the browser CSPRNG (128 bits).',
    `Entropy hex: ${hex(wallet.entropy)}`,
    'SHA-256 digest of entropy (all 32 bytes):',
    indexedBytes(wallet.entropyHash),
    `Checksum: first 4 digest bits = ${wallet.entropyChecksum}`,
    'Carry/transform: append those 4 bits to the 128 entropy bits = 132 bits.',
    'Split the 132-bit stream into twelve 11-bit integers; each integer indexes the BIP-39 English list.',
    'Word mapping (position | 11 bits | zero-based list index | word):',
    ...wallet.phrase.split(' ').map((word, index) => `${String(index + 1).padStart(2, '0')} | ${wallet.wordChunks[index]} | ${String(wordlist.indexOf(word)).padStart(4, '0')} | ${word}`),
    `Mnemonic: ${wallet.phrase}`,
    `Mnemonic decodes back to original entropy: ${hex(entropyRoundTrip)} (match: ${hex(entropyRoundTrip) === hex(wallet.entropy)})`,
    'Reversibility: word-index mapping restores the entropy; checksum is verified, not extra entropy.',
    '',
    'STEP 2 — MNEMONIC + PASSPHRASE → 512-BIT BIP-39 SEED',
    'Normalize mnemonic and passphrase with Unicode NFKD. PBKDF2-HMAC-SHA512 uses 2,048 iterations and dkLen=64 bytes.',
    'Salt is UTF-8("mnemonic" + NFKD(passphrase)); full salt bytes:',
    indexedBytes(wallet.bip39Salt),
    `Seed hex (64 bytes / 512 bits): ${hex(wallet.seed)}`,
    'Carry/transform: the 64-byte derived output is new key material, not an encrypted or reversible copy of the phrase.',
    '',
    'STEP 3 — BIP-39 SEED → BIP-32 MASTER NODE',
    'HMAC-SHA512(key=UTF-8("Bitcoin seed"), data=the 64-byte BIP-39 seed).',
    `Full HMAC output IL || IR (64 bytes): ${hex(wallet.masterHmacOutput)}`,
    `IL / master private scalar (first 32 bytes): ${hex(wallet.master.privateKey)}`,
    `IR / master chain code (last 32 bytes): ${hex(wallet.master.chainCode)}`,
    'Carry/transform: IL and IR form the master node. HMAC output does not provide a practical inverse to recover the seed.',
    '',
    `STEP 4 — BIP-32 MASTER → ${selectedNetwork().label.toUpperCase()} ACCOUNT`,
    `Derive each child in path order; apostrophe means hardened. Path: ${selectedNetwork().path}.`,
    pathReport,
    `Final account private key: ${hex(wallet.account.privateKey)}`,
    '',
    `STEP 5 — SECP256K1 PUBLIC KEY → ${selectedNetwork().label.toUpperCase()} ADDRESS`,
    ...networkAddressExportLines(),
    '',
    'REVERSIBILITY SUMMARY',
    'Mnemonic ↔ entropy: reversible encoding (checksum can be validated).',
    'Mnemonic/passphrase → seed: PBKDF2 is not practically invertible; only candidate phrases can be checked by deriving forward.',
    'Seed → BIP-32 node → child keys: deterministic forward derivation; path and hardened levels matter.',
    'Private key → public key: elliptic-curve scalar multiplication; reversing requires solving the secp256k1 discrete-log problem.',
    selectedNetwork().family === 'bitcoin' ? 'Bitcoin address: HASH160 of the compressed public key, then native-SegWit Bech32; no practical inverse.' : selectedNetwork().family === 'tron' ? 'TRON address: Keccak-256 truncation plus Base58Check version and checksum; no practical inverse.' : 'EVM address: Keccak-256 truncation and EIP-55 casing; no practical inverse.' ,
    '',
    'BOUNDED SECP256K1 ADDRESS SEARCH (if run)',
    ...networkSearchExportLines(),
    '',
    'END — Treat this file as secret because it contains the phrase, passphrase, seed, and private keys.',
  ].join('\n');

  const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `seedlab-derivation-${wallet.address.slice(2).toLowerCase()}.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function wipeWalletSecrets() {
  wallet.entropy?.fill(0);
  wallet.bip39Salt?.fill(0);
  wallet.seed?.fill(0);
  wallet.masterHmacOutput?.fill(0);
  wallet.master?.wipePrivateData();
  wallet.pathNodes.forEach((entry) => entry.node?.wipePrivateData());
  wallet.account?.wipePrivateData();
}

function resetWallet() {
  wipeWalletSecrets();
  wallet = freshWallet();
  passphrase = '';
  backwardOpen = false;
  discreteLogResult = null;
  labAddressInput = null;
  copied = new Set();
  render();
}

render();
