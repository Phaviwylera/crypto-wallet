import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import './style.css';

const app = document.querySelector('#app');
const DERIVATION_PATH = "m/44'/60'/0'/0/0";
let wallet = freshWallet();
let passphrase = '';
let copied = new Set();
let backwardOpen = false;

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
    address: '',
  };
}

function hex(bytes) {
  return bytes ? bytesToHex(bytes) : '';
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
    publicBody: () => hex(wallet.publicKey?.slice(1)),
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
    <p class="step-explanation">The phrase is the human-readable encoding of the entropy plus checksum. It is not the 512-bit seed and is not an Ethereum address.</p>` : '<p class="locked-note">The twelve-word phrase is produced from the entropy and checksum above.</p>';

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
    <div class="path-value"><span class="mini-label">ETHEREUM ACCOUNT PATH</span><code>${DERIVATION_PATH}</code></div>
    <div class="path-legend"><span><b>44′</b> BIP-44 purpose</span><span><b>60′</b> Ethereum coin type</span><span><b>0′</b> account</span><span><b>0</b> external chain</span><span><b>0</b> address index</span></div>
    <p class="step-explanation">BIP-32 walks the path one child at a time. Each level carries a new private node and chain code forward; hardened levels (apostrophe) use private parent material. The path is a wallet convention, not embedded in the eventual address.</p>
    <div class="path-node-list">${wallet.pathNodes.map((entry) => `<details class="path-node"><summary><span>${entry.fullPath}</span><small>${entry.hardened ? 'HARDENED' : 'NORMAL'} · index 0x${entry.childIndex.toString(16).padStart(8, '0')}</small></summary><div class="value-row"><div><label>Child private key</label><code>${spacedHex(entry.node.privateKey)}</code></div></div><div class="value-row"><div><label>Child chain code</label><code>${spacedHex(entry.node.chainCode)}</code></div></div><div class="value-row"><div><label>Child compressed public key</label><code>${spacedHex(entry.node.publicKey)}</code></div></div></details>`).join('')}</div>
    <div class="value-row"><div><label>Final account private key</label><code>${spacedHex(wallet.account.privateKey)}</code></div>${copyButton('accountPrivate')}</div>
    <div class="value-row"><div><label>Uncompressed secp256k1 public key · 65 bytes</label><code>${spacedHex(wallet.publicKey)}</code></div>${copyButton('publicKey')}</div>` : '<p class="locked-note">Derive the first Ethereum account at <code>m/44′/60′/0′/0/0</code>, then compute its public key on secp256k1.</p>';

  const addressBody = wallet.stage >= 5 ? `
    <p class="step-explanation">Ethereum takes the uncompressed public key’s 64-byte body (X || Y), omitting the leading <code>04</code>. Keccak-256 absorbs it into a 1,600-bit state: 136-byte rate, 64-byte capacity, Keccak padding (<code>01…80</code>), then 24 permutation rounds. The first 32 output bytes are the digest. Ethereum Keccak-256 uses legacy Keccak padding, not standardized SHA3-256.</p>
    <div class="hash-block"><div class="hash-block-heading"><label>INPUT · PUBLIC KEY BODY · 64 BYTES · PREFIX 04 OMITTED</label>${copyButton('publicBody', 'Copy input')}</div><div class="hash-byte-grid input-byte-grid">${byteGrid(wallet.publicKey.slice(1))}</div></div>
    <div class="hash-params"><span>RATE <b>136 bytes</b></span><span>CAPACITY <b>64 bytes</b></span><span>ROUNDS <b>24</b></span><span>OUTPUT <b>32 bytes</b></span></div>
    <div class="hash-block"><div class="hash-block-heading"><label>OUTPUT · FULL KECCAK-256 DIGEST · 32 BYTES</label>${copyButton('keccak', 'Copy hash')}</div><div class="hash-byte-grid output-byte-grid">${byteGrid(wallet.keccakHash, 12)}</div><p class="hash-footnote">Byte indices <code>0c–1f</code> (highlighted) are the final 20 bytes used for the Ethereum address. The first 12 digest bytes are discarded.</p></div>
    <div class="hash-block"><div class="hash-block-heading"><label>ADDRESS PAYLOAD · 20 RAW BYTES</label>${copyButton('addressBytes', 'Copy bytes')}</div><div class="hash-byte-grid address-byte-grid">${byteGrid(wallet.addressBytes)}</div></div>
    <div class="value-row"><div><label>EIP-55 hash · Keccak-256 of lowercase address text</label><code>${spacedHex(wallet.eip55Hash)}</code></div>${copyButton('eip55Hash')}</div>
    <div class="address-output"><div><span class="mini-label">ETHEREUM ADDRESS · EIP-55</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>` : '<p class="locked-note">Hash the uncompressed public-key body with Ethereum Keccak-256; take the last 20 bytes and apply EIP-55 checksum casing.</p>';

  const recoveredEntropy = wallet.stage >= 5 ? mnemonicToEntropy(wallet.phrase, wordlist) : null;
  const entropyRoundTripMatches = recoveredEntropy && hex(recoveredEntropy) === hex(wallet.entropy);
  const backwardPanel = wallet.stage >= 5 && backwardOpen ? `
    <section class="backward-panel">
      <div class="backward-heading"><div><span class="eyebrow">LIVE REVERSE TRACE</span><h3>What can—and cannot—be recovered?</h3></div><span class="live-example">THIS SESSION · REAL VALUES</span></div>
      <p class="backward-intro">Read from your generated address back toward entropy. The forward outputs are visible above; these rows show what each output still tells you about its input.</p>
      <div class="carry-strip"><span><b>Carried forward</b> deterministic relationships, checksums, and the chosen derivation path</span><span><b>Changed at each step</b> representation, key material, and finally a shortened hash</span></div>
      <div class="reverse-list">
        <article class="reverse-row blocked"><div class="reverse-step">06</div><div class="reverse-content"><div class="reverse-title"><strong>Address ← public key</strong><span class="recovery-tag no">NOT REVERSIBLE</span></div><div class="reverse-live"><label>Live address</label><code>${wallet.address}</code></div><p>Keccak-256 hashes the public-key body, then the address keeps only 20 of the 32 hash bytes. There is no inverse formula to recover the public key from this value.</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">05</div><div class="reverse-content"><div class="reverse-title"><strong>Public key ← private key</strong><span class="recovery-tag no">NOT PRACTICAL</span></div><div class="reverse-live"><label>Live public key</label><code>${shortHex(wallet.publicKey, 18, 12)}</code></div><p>The public key is <code>Q = d × G</code> on secp256k1. Finding <code>d</code> from <code>Q</code> requires solving the elliptic-curve discrete-log problem.</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">04</div><div class="reverse-content"><div class="reverse-title"><strong>Child key ← master node + path</strong><span class="recovery-tag no">PATH MATTERS</span></div><div class="reverse-live"><label>Path used</label><code>${DERIVATION_PATH}</code><label class="second-live-label">Live child key</label><code>${shortHex(wallet.account.privateKey, 18, 12)}</code></div><p>BIP-32 derives a child using HMAC-SHA512 and the selected path. The address does not encode that path. A child key alone lacks the parent chain code; hardened levels (44′, 60′, 0′) also block deriving ancestors.</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">03</div><div class="reverse-content"><div class="reverse-title"><strong>Master node ← BIP-39 seed</strong><span class="recovery-tag no">NOT PRACTICAL</span></div><div class="reverse-live"><label>Master private · IL</label><code>${shortHex(wallet.master.privateKey, 18, 12)}</code><label class="second-live-label">Master chain code · IR</label><code>${shortHex(wallet.master.chainCode, 18, 12)}</code></div><p>BIP-32 creates these with HMAC-SHA512 using the key <code>Bitcoin seed</code>. The master node is derived from the seed; it does not contain a reversible copy of it.</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">02</div><div class="reverse-content"><div class="reverse-title"><strong>Seed ← mnemonic + passphrase</strong><span class="recovery-tag no">CANDIDATES ONLY</span></div><div class="reverse-live"><label>Live seed · abbreviated</label><code>${shortHex(wallet.seed, 20, 12)}</code><label class="second-live-label">Passphrase used</label><code>${passphrase ? 'non-empty · hidden' : 'empty'}</code></div><p>PBKDF2-HMAC-SHA512 produces a 512-bit seed. It is not an encrypted copy of the words. You can test a guessed phrase and passphrase by running forward and comparing, but cannot extract the original from the seed.</p></div></article>
        <article class="reverse-row reversible"><div class="reverse-step">01</div><div class="reverse-content"><div class="reverse-title"><strong>Mnemonic → entropy</strong><span class="recovery-tag yes">REVERSIBLE</span></div><div class="reverse-live"><label>Live phrase</label><code>${wallet.phrase}</code><label class="second-live-label">Recovered entropy · matches original: ${entropyRoundTripMatches ? 'YES' : 'NO'}</label><code>${spacedHex(recoveredEntropy)}</code></div><p>This is the exception: the 12 word indices encode the 128 entropy bits plus a 4-bit checksum. BIP-39 can decode the phrase back to the exact entropy and verify its checksum.</p></div></article>
      </div>
      <div class="takeaway"><strong>Why address → phrase search is not practical</strong><span>With no phrase words known, a search must try up to 2<sup>128</sup> valid mnemonics (and know the passphrase and derivation path), derive each address, then compare. This is not a useful workload for the $85 EC2 budget.</span></div>
    </section>` : '';

  app.innerHTML = `
    <header class="topbar"><a class="brand" href="#" aria-label="Seedlab home"><span class="brand-mark">S</span><span>seedlab</span></a><div class="topbar-meta"><span class="live-dot"></span> DERIVATION LAB <span class="topbar-divider">/</span> TEST DATA ONLY</div></header>
    <main class="page-shell">
      <div class="page-heading"><div><div class="eyebrow">WALLET BUILD · 5 CALCULATIONS</div><h1>Trace a wallet to its address.</h1><p>Run each calculation in order. Every value is generated in this browser session.</p></div><div class="session-chip"><span class="session-dot"></span>${wallet.stage ? `STEP ${String(Math.min(wallet.stage + 1, 5)).padStart(2, '0')} OF 05` : 'READY TO START'}</div></div>
      <div class="security-banner"><span class="alert-mark">!</span><p><strong>Public HTTP learning demo.</strong> Secret values stay in this browser; HTTP can be intercepted or altered. Never enter real wallet secrets. The optional TXT export is unencrypted and contains the phrase, passphrase, seed, and private keys; it requires confirmation.</p></div>
      <div class="layout-grid">
        <div class="lesson-column">
          <section class="setup-card"><div class="setup-copy"><span class="eyebrow">START HERE</span><h2>Make a fresh demo wallet</h2><p>Uses browser cryptographic randomness. Nothing is saved or sent to EC2.</p></div><div class="setup-controls"><label for="passphrase">Optional BIP-39 passphrase</label><input id="passphrase" type="password" autocomplete="new-password" placeholder="Leave blank for no passphrase" value="${passphrase.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}" ${wallet.stage ? 'disabled' : ''}><small>${wallet.stage ? 'Locked for this derivation; reset to change it.' : 'Case-sensitive. It creates a different wallet.'}</small><button class="action-button generate-button" id="generate">${wallet.stage ? 'Generate another demo wallet' : 'Generate demo wallet'}<span aria-hidden="true">↗</span></button></div></section>
          <div class="steps-heading"><div><span class="eyebrow">THE PIPELINE</span><h2>Five steps, one address</h2></div><div class="steps-actions">${wallet.stage >= 5 ? `<button class="export-button" id="export-txt">Export full TXT</button><button class="reverse-toggle" id="backward-toggle">${backwardOpen ? 'Hide backward trace' : 'Trace backward'}</button>` : ''}${wallet.stage ? '<button class="reset-button" id="reset">Reset session</button>' : ''}</div></div>
          ${stepCard({ number: '01', title: 'Entropy → mnemonic', caption: 'Create randomness and encode twelve words', step: 1, body: entropyBody, action: 'Generate 128-bit entropy & phrase' })}
          ${stepCard({ number: '02', title: 'Mnemonic → seed', caption: 'PBKDF2-HMAC-SHA512 · BIP-39', step: 2, body: seedBody, action: 'Derive 512-bit seed' })}
          ${stepCard({ number: '03', title: 'Seed → master node', caption: 'HMAC-SHA512 · BIP-32', step: 3, body: masterBody, action: 'Create BIP-32 master node' })}
          ${stepCard({ number: '04', title: 'Master node → Ethereum keypair', caption: 'BIP-44 path · secp256k1', step: 4, body: accountBody, action: 'Derive Ethereum account' })}
          ${stepCard({ number: '05', title: 'Public key → address', caption: 'Keccak-256 · last 20 bytes · EIP-55', step: 5, body: addressBody, action: 'Compute Ethereum address' })}
          ${backwardPanel}
        </div>
        <aside class="side-rail">
          <section class="rail-card"><div class="rail-title"><span class="eyebrow">MAP</span><span class="rail-index">01—05</span></div><ol class="flow-list"><li class="${wallet.stage >= 1 ? 'visited' : ''}"><b>01</b><span>128-bit entropy</span></li><li class="${wallet.stage >= 1 ? 'visited' : ''}"><b>02</b><span>12 BIP-39 words</span></li><li class="${wallet.stage >= 2 ? 'visited' : ''}"><b>03</b><span>512-bit seed</span></li><li class="${wallet.stage >= 3 ? 'visited' : ''}"><b>04</b><span>BIP-32 master node</span></li><li class="${wallet.stage >= 4 ? 'visited' : ''}"><b>05</b><span>Ethereum keypair</span></li><li class="${wallet.stage >= 5 ? 'visited current' : ''}"><b>↳</b><span>20-byte address</span></li></ol></section>
          <section class="rail-card path-card"><span class="eyebrow">DEFAULT PATH</span><code>${DERIVATION_PATH}</code><p>Changing the path changes which account address is derived from the same seed.</p></section>
          <section class="rail-card note-card"><span class="note-icon">i</span><div><strong>Keep the direction clear</strong><p>Each step derives new material from the prior value. The process does not provide a practical way to reverse a seed into its original phrase.</p></div></section>
          <div class="rail-foot">LOCAL SESSION <span>·</span> NO SERVER API</div>
        </aside>
      </div>
      <footer class="page-footer"><span>SEEDLAB <span class="footer-muted">· INTERACTIVE CRYPTOGRAPHY PRIMER</span></span><span>TEST VALUES ONLY · NEVER FOR FUNDS</span></footer>
    </main>`;

  const passInput = document.querySelector('#passphrase');
  passInput?.addEventListener('input', (event) => { passphrase = event.target.value; });
  document.querySelector('#generate')?.addEventListener('click', generateWallet);
  document.querySelector('#reset')?.addEventListener('click', resetWallet);
  document.querySelector('#backward-toggle')?.addEventListener('click', () => {
    backwardOpen = !backwardOpen;
    render();
  });
  document.querySelector('#export-txt')?.addEventListener('click', exportDerivationTxt);
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

function generateWallet() {
  try {
    const passInput = document.querySelector('#passphrase');
    if (passInput) passphrase = passInput.value;
    const entropy = new Uint8Array(16);
    globalThis.crypto.getRandomValues(entropy);
    wipeWalletSecrets();
    wallet = freshWallet();
    backwardOpen = false;
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
      const segments = ["44'", "60'", "0'", '0', '0'];
      wallet.pathNodes = segments.map((segment, index) => {
        const fullPath = `m/${segments.slice(0, index + 1).join('/')}`;
        const node = wallet.master.derive(fullPath);
        const value = Number(segment.replace("'", ''));
        const hardened = segment.endsWith("'");
        return { segment, fullPath, hardened, childIndex: value + (hardened ? 0x80000000 : 0), node };
      });
      wallet.account = wallet.pathNodes.at(-1).node;
      wallet.publicKey = secp256k1.getPublicKey(wallet.account.privateKey, false);
    } else if (step === 5 && wallet.stage === 4) {
      wallet.keccakHash = keccak_256(wallet.publicKey.slice(1));
      wallet.addressBytes = wallet.keccakHash.slice(12);
      const lowerAddress = hex(wallet.addressBytes);
      wallet.eip55Hash = keccak_256(new TextEncoder().encode(lowerAddress));
      wallet.address = checksumAddress(lowerAddress, wallet.eip55Hash);
    }
    wallet.stage = step;
    copied = new Set();
    render();
  } catch (error) {
    console.error(error);
    alert('That derivation step failed. Reset and try again in a modern browser.');
  }
}

function indexedBytes(bytes) {
  return Array.from(bytes, (value, index) => `${String(index).padStart(2, '0')}  0x${value.toString(16).padStart(2, '0')}`).join('\n');
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
    `Ethereum derivation path: ${DERIVATION_PATH}`,
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
    'STEP 4 — BIP-32 MASTER → BIP-44 ETHEREUM ACCOUNT',
    'Derive each child in order; apostrophe means hardened. Path: m/44\'/60\'/0\'/0/0.',
    pathReport,
    `Final account private key: ${hex(wallet.account.privateKey)}`,
    '',
    'STEP 5 — SECP256K1 PUBLIC KEY → ETHEREUM ADDRESS',
    'Uncompressed public key is 0x04 || X || Y (65 bytes). Ethereum Keccak input excludes the 0x04 byte.',
    `Uncompressed public key (65 bytes): ${hex(wallet.publicKey)}`,
    `X coordinate (32 bytes): ${hex(wallet.publicKey.slice(1, 33))}`,
    `Y coordinate (32 bytes): ${hex(wallet.publicKey.slice(33, 65))}`,
    `Keccak input public-key body (64 bytes): ${hex(wallet.publicKey.slice(1))}`,
    'Keccak-256 parameters: 1600-bit state; 136-byte rate; 64-byte capacity; legacy Keccak pad 0x01…0x80; 24 permutation rounds; 32-byte output.',
    'Ethereum Keccak-256 uses legacy Keccak padding; it is not standardized SHA3-256.',
    'Full Keccak-256 digest, indexed output bytes:',
    indexedBytes(wallet.keccakHash),
    'Address takes digest bytes 12..31 (hex indices 0c..1f), i.e. the final 20 bytes:',
    indexedBytes(wallet.addressBytes),
    `Lowercase 20-byte address: 0x${hex(wallet.addressBytes)}`,
    `EIP-55 checksum hash of lowercase address text: ${hex(wallet.eip55Hash)}`,
    `Checksummed Ethereum address: ${wallet.address}`,
    'Carry/discard: Keccak hash is one-way; first 12 digest bytes are discarded for the 20-byte address. EIP-55 casing adds a display checksum.',
    '',
    'REVERSIBILITY SUMMARY',
    'Mnemonic ↔ entropy: reversible encoding (checksum can be validated).',
    'Mnemonic/passphrase → seed: PBKDF2 is not practically invertible; only candidate phrases can be checked by deriving forward.',
    'Seed → BIP-32 node → child keys: deterministic forward derivation; path and hardened levels matter.',
    'Private key → public key: elliptic-curve scalar multiplication; reversing requires solving the secp256k1 discrete-log problem.',
    'Public key → address: Keccak-256 plus truncation; no practical inverse.',
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
  copied = new Set();
  render();
}

render();
