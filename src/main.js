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
    entropyChecksum: '',
    phrase: '',
    seed: null,
    master: null,
    account: null,
    publicKey: null,
    keccakHash: null,
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

function binary(bytes) {
  return Array.from(bytes, (value) => value.toString(2).padStart(8, '0')).join('');
}

function checksumAddress(lowerHex) {
  const lower = lowerHex.toLowerCase();
  const hash = hex(keccak_256(new TextEncoder().encode(lower)));
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
    phrase: () => wallet.phrase,
    seed: () => hex(wallet.seed),
    masterPrivate: () => hex(wallet.master?.privateKey),
    chainCode: () => hex(wallet.master?.chainCode),
    accountPrivate: () => hex(wallet.account?.privateKey),
    publicKey: () => hex(wallet.publicKey),
    keccak: () => hex(wallet.keccakHash),
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
    return `<div class="mnemonic-word"><span>${String(index + 1).padStart(2, '0')}</span><b>${word}</b><small>index ${String(wordIndex).padStart(4, '0')}</small></div>`;
  }).join('');

  const entropyBody = entropyReady ? `
    <div class="value-row"><div><label>128-bit entropy · 16 bytes</label><code>${spacedHex(wallet.entropy)}</code></div>${copyButton('entropy')}</div>
    <div class="checksum-strip"><span class="mini-label">SHA-256 CHECKSUM · FIRST 4 BITS</span><code>${wallet.entropyChecksum}</code><span class="checksum-explain">128 entropy bits + 4 checksum bits = 132 bits</span></div>
    <div class="mnemonic-grid">${wordGrid}</div>
    <p class="step-explanation">BIP-39 splits the 132-bit sequence into twelve 11-bit numbers. Each number (0–2047) selects a word from the English list. The last word carries part of the entropy and the checksum.</p>` : `
    <p class="step-explanation">Generate 16 cryptographically random bytes. BIP-39 appends the first 4 bits of SHA-256(entropy), then maps the 132 bits to twelve words.</p>
    <div class="empty-inline">No phrase or keys exist until you generate a demo wallet.</div>`;

  const phraseBody = entropyReady ? `
    <div class="phrase-title-row"><span class="mini-label">12-WORD BIP-39 MNEMONIC</span>${copyButton('phrase', 'Copy phrase')}</div>
    <div class="mnemonic-grid compact-words">${wordGrid}</div>
    <p class="step-explanation">The phrase is the human-readable encoding of the entropy plus checksum. It is not the 512-bit seed and is not an Ethereum address.</p>` : '<p class="locked-note">The twelve-word phrase is produced from the entropy and checksum above.</p>';

  const seedBody = wallet.stage >= 2 ? `
    <div class="formula-line"><span>PBKDF2-HMAC-SHA512</span><span>2,048 rounds</span><span>output: 64 bytes</span></div>
    <p class="step-explanation">Input: NFKD-normalized mnemonic. Salt: <code>mnemonic</code> + the optional passphrase you entered. The passphrase is case-sensitive and changes the resulting wallet.</p>
    <div class="value-row"><div><label>512-bit BIP-39 seed · 64 bytes</label><code>${spacedHex(wallet.seed)}</code></div>${copyButton('seed', 'Copy seed')}</div>` : '<p class="locked-note">This runs PBKDF2-HMAC-SHA512 on the phrase. The result is seed material—not a private key.</p>';

  const masterBody = wallet.stage >= 3 ? `
    <p class="step-explanation">BIP-32 computes HMAC-SHA512(key = <code>Bitcoin seed</code>, data = seed). The 64-byte result splits into IL (master private scalar) and IR (master chain code).</p>
    <div class="value-row"><div><label>Master private key · IL</label><code>${spacedHex(wallet.master.privateKey)}</code></div>${copyButton('masterPrivate')}</div>
    <div class="value-row"><div><label>Master chain code · IR</label><code>${spacedHex(wallet.master.chainCode)}</code></div>${copyButton('chainCode')}</div>
    <p class="step-explanation subtle">The master node is a root from which a hierarchy of keys can be derived. It is not the Ethereum address.</p>` : '<p class="locked-note">BIP-32 turns the seed into a master private key and chain code using HMAC-SHA512.</p>';

  const accountBody = wallet.stage >= 4 ? `
    <div class="path-value"><span class="mini-label">ETHEREUM ACCOUNT PATH</span><code>${DERIVATION_PATH}</code></div>
    <div class="path-legend"><span><b>44′</b> BIP-44 purpose</span><span><b>60′</b> Ethereum coin type</span><span><b>0′</b> account</span><span><b>0</b> external chain</span><span><b>0</b> address index</span></div>
    <p class="step-explanation">BIP-32 child-key derivation walks this path. Hardened levels use the parent private key; the final levels derive the first external Ethereum account.</p>
    <div class="value-row"><div><label>Derived account private key</label><code>${spacedHex(wallet.account.privateKey)}</code></div>${copyButton('accountPrivate')}</div>
    <div class="value-row"><div><label>Uncompressed secp256k1 public key · 65 bytes</label><code>${spacedHex(wallet.publicKey)}</code></div>${copyButton('publicKey')}</div>` : '<p class="locked-note">Derive the first Ethereum account at <code>m/44′/60′/0′/0/0</code>, then compute its public key on secp256k1.</p>';

  const addressBody = wallet.stage >= 5 ? `
    <p class="step-explanation">Ethereum hashes the 64-byte public-key body (without the leading <code>04</code>) with Keccak-256. The last 20 bytes form the address. EIP-55 uses hash nibbles to capitalize letters for a checksum.</p>
    <div class="value-row"><div><label>Keccak-256(public key body)</label><code>${spacedHex(wallet.keccakHash)}</code></div>${copyButton('keccak')}</div>
    <div class="address-output"><div><span class="mini-label">ETHEREUM ADDRESS · EIP-55</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>` : '<p class="locked-note">Hash the uncompressed public-key body with Keccak-256; take the last 20 bytes and apply EIP-55 checksum casing.</p>';

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
      <div class="security-banner"><span class="alert-mark">!</span><p><strong>Public HTTP learning demo.</strong> Secret values are shown and copied in this browser. HTTP can be intercepted or altered. Never use a real phrase, passphrase, seed, or key here.</p></div>
      <div class="layout-grid">
        <div class="lesson-column">
          <section class="setup-card"><div class="setup-copy"><span class="eyebrow">START HERE</span><h2>Make a fresh demo wallet</h2><p>Uses browser cryptographic randomness. Nothing is saved or sent to EC2.</p></div><div class="setup-controls"><label for="passphrase">Optional BIP-39 passphrase</label><input id="passphrase" type="password" autocomplete="new-password" placeholder="Leave blank for no passphrase" value="${passphrase.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}" ${wallet.stage ? 'disabled' : ''}><small>${wallet.stage ? 'Locked for this derivation; reset to change it.' : 'Case-sensitive. It creates a different wallet.'}</small><button class="action-button generate-button" id="generate">${wallet.stage ? 'Generate another demo wallet' : 'Generate demo wallet'}<span aria-hidden="true">↗</span></button></div></section>
          <div class="steps-heading"><div><span class="eyebrow">THE PIPELINE</span><h2>Five steps, one address</h2></div><div class="steps-actions">${wallet.stage >= 5 ? `<button class="reverse-toggle" id="backward-toggle">${backwardOpen ? 'Hide backward trace' : 'Trace backward'}</button>` : ''}${wallet.stage ? '<button class="reset-button" id="reset">Reset session</button>' : ''}</div></div>
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
    wallet = freshWallet();
    backwardOpen = false;
    wallet.entropy = entropy;
    wallet.entropyChecksum = binary(sha256(entropy)).slice(0, 4);
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
      wallet.seed = mnemonicToSeedSync(wallet.phrase, passphrase);
    } else if (step === 3 && wallet.stage === 2) {
      wallet.master = HDKey.fromMasterSeed(wallet.seed);
    } else if (step === 4 && wallet.stage === 3) {
      wallet.account = wallet.master.derive(DERIVATION_PATH);
      wallet.publicKey = secp256k1.getPublicKey(wallet.account.privateKey, false);
    } else if (step === 5 && wallet.stage === 4) {
      wallet.keccakHash = keccak_256(wallet.publicKey.slice(1));
      const lowerAddress = hex(wallet.keccakHash.slice(12));
      wallet.address = checksumAddress(lowerAddress);
    }
    wallet.stage = step;
    copied = new Set();
    render();
  } catch (error) {
    console.error(error);
    alert('That derivation step failed. Reset and try again in a modern browser.');
  }
}

function resetWallet() {
  wallet.entropy?.fill(0);
  wallet.seed?.fill(0);
  wallet.master?.wipePrivateData();
  wallet.account?.wipePrivateData();
  wallet = freshWallet();
  passphrase = '';
  backwardOpen = false;
  copied = new Set();
  render();
}

render();
