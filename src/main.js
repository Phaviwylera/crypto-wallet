import { HDKey } from '@scure/bip32';
import { base58, bech32, bech32m } from '@scure/base';
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
  bitcoin: { label: 'Bitcoin · Native SegWit', shortLabel: 'BTC P2WPKH', family: 'bitcoin', format: 'p2wpkh', path: "m/84'/0'/0'/0/0", pathLabels: ['BIP-84 purpose', 'Bitcoin coin type', 'account', 'receive chain', 'address index'] },
  bitcoinLegacy: { label: 'Bitcoin · Legacy', shortLabel: 'BTC Legacy', family: 'bitcoin', format: 'p2pkh', path: "m/44'/0'/0'/0/0", pathLabels: ['BIP-44 purpose', 'Bitcoin coin type', 'account', 'external chain', 'address index'] },
  bitcoinNested: { label: 'Bitcoin · Nested SegWit', shortLabel: 'BTC Nested', family: 'bitcoin', format: 'p2sh-p2wpkh', path: "m/49'/0'/0'/0/0", pathLabels: ['BIP-49 purpose', 'Bitcoin coin type', 'account', 'change chain', 'address index'] },
  bitcoinTaproot: { label: 'Bitcoin · Taproot', shortLabel: 'BTC Taproot', family: 'bitcoin', format: 'p2tr', path: "m/86'/0'/0'/0/0", pathLabels: ['BIP-86 purpose', 'Bitcoin coin type', 'account', 'change chain', 'address index'] },
  tron: { label: 'TRON', shortLabel: 'TRX', family: 'tron', path: "m/44'/195'/0'/0/0", pathLabels: ['BIP-44 purpose', 'TRON coin type', 'account', 'external chain', 'address index'] },
  bnb: { label: 'BNB Smart Chain', shortLabel: 'BNB Smart Chain', family: 'evm', path: "m/44'/60'/0'/0/0", pathLabels: ['BIP-44 purpose', 'EVM coin type', 'account', 'external chain', 'address index'] },
  bnbBeacon: { label: 'BNB Beacon Chain · Legacy', shortLabel: 'BNB Beacon', family: 'bnbBeacon', path: "m/44'/714'/0'/0/0", pathLabels: ['BIP-44 purpose', 'BNB coin type', 'account', 'external chain', 'address index'] },
};
let selectedNetworkId = 'ethereum';
const SEARCH_BATCH_SIZE = 256;
const SEARCH_SCALAR_LIMIT = 10_000_000;
const selectedNetwork = () => NETWORKS[selectedNetworkId];
let wallet = freshWallet();
let passphrase = '';
let copied = new Set();
let backwardOpen = false;
let discreteLogResult = null;
let discreteLogProgress = null;
let autoSearchEnabled = false;
let searchRunId = 0;
let labAddressInput = null;
let pendingFile = null;
let scanState = { jobId: null, status: 'idle', total: 0, processed: 0, results: [], error: null, hideEmpty: true };
const API_BASE = (import.meta.env && import.meta.env.VITE_SCAN_API_BASE) || '';

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
    tronShaFirst: null,
    tronShaSecond: null,
    tronChecksum: null,
    tronBase58Bytes: null,
    btcHash160: null,
    btcSha256: null,
    btcRedeemScript: null,
    btcScriptHash: null,
    btcPayload: null,
    btcChecksum: null,
    taprootData: null,
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

function looksLikeEvmPublicKey(input) {
  const key = input.trim().replace(/\s+/g, '').replace(/^0x/i, '');
  return /^(?:[0-9a-fA-F]{128}|04[0-9a-fA-F]{128}|0[23][0-9a-fA-F]{64})$/.test(key);
}

function addressPlaceholder() {
  const network = selectedNetwork();
  if (selectedNetworkId === 'bitcoinTaproot') return 'bc1p…';
  if (network.family === 'bitcoin') return network.format === 'p2wpkh' ? 'bc1q…' : network.format === 'p2sh-p2wpkh' ? '3…' : '1…';
  if (network.family === 'bnbBeacon') return 'bnb1…';
  return network.family === 'tron' ? 'T…' : '0x…';
}

function addressCaption(network = selectedNetwork()) {
  if (network.family === 'bitcoin') {
    return ({ p2wpkh: 'BIP-84 · HASH160 · Bech32', p2pkh: 'BIP-44 · HASH160 · Base58Check', 'p2sh-p2wpkh': 'BIP-49 · nested SegWit · Base58Check', p2tr: 'BIP-86 · TapTweak · Bech32m' })[network.format];
  }
  if (network.family === 'bnbBeacon') return 'BIP-44 · HASH160 · Bech32';
  if (network.family === 'tron') return 'Keccak-256 · Base58Check';
  return 'Keccak-256 · last 20 bytes · EIP-55';
}

function addressInputHint() {
  const network = selectedNetwork();
  if (network.family === 'bitcoin') {
    if (network.format === 'p2wpkh') return 'Bitcoin mainnet P2WPKH native SegWit (bc1q…), Bech32 v0.';
    if (network.format === 'p2tr') return 'Bitcoin mainnet P2TR Taproot (bc1p…), BIP-86 and Bech32m v1.';
    if (network.format === 'p2sh-p2wpkh') return 'Bitcoin mainnet P2SH-wrapped P2WPKH (3…), BIP-49 Base58Check.';
    return 'Bitcoin mainnet P2PKH legacy address (1…), BIP-44 Base58Check.';
  }
  if (network.family === 'bnbBeacon') return 'BNB Beacon Chain Bech32 address with bnb human-readable prefix.';
  if (network.family === 'tron') return 'TRON mainnet Base58Check address (usually starts with T).';
  return 'Paste a 20-byte 0x address, or a 33/64/65-byte secp256k1 public key to calculate its full Keccak-256 digest. Mixed-case addresses must pass EIP-55.';
}

function networkAddressDetails(parsed, network) {
  if (network.family === 'bitcoin') {
    if (network.format === 'p2wpkh') {
      const scriptPubKey = new Uint8Array([0x00, 0x14, ...parsed.bytes]);
      return `<p>Witness version: <b>0</b> · HRP: <b>bc</b> · Bech32 v0</p><p>HASH160 witness program: <code>${hex(parsed.bytes)}</code></p><p>P2WPKH scriptPubKey: <code>${hex(scriptPubKey)}</code></p>`;
    }
    if (network.format === 'p2tr') return `<p>Witness version: <b>1</b> · HRP: <b>bc</b> · Bech32m</p><p>Taproot output-key program: <code>${hex(parsed.bytes)}</code></p>`;
    return network.format === 'p2pkh'
      ? `<p>P2PKH payload (version 00 || HASH160): <code>${hex(parsed.payload)}</code></p><p>Base58Check checksum: <code>${hex(parsed.checksum)}</code> · verified</p>`
      : `<p>P2SH script hash: <code>${hex(parsed.bytes)}</code></p><p>P2SH payload (version 05 || script hash): <code>${hex(parsed.payload)}</code></p><p>Base58Check checksum: <code>${hex(parsed.checksum)}</code> · verified</p><p>The address alone does not reveal the redeem script; a candidate's script is derived from its public key.</p>`;
  }
  if (network.family === 'bnbBeacon') return `<p>HASH160(compressed public key): <code>${hex(parsed.bytes)}</code></p><p>Bech32 HRP: <b>bnb</b> · checksum verified</p>`;
  if (network.family === 'tron') return `<p>Version + address payload: <code>${hex(parsed.payload)}</code></p><p>Base58Check checksum: <code>${hex(parsed.checksum)}</code> · verified</p>`;
  if (parsed.inputKind === 'publicKey') return `<p>EIP-55 checksum hash of lowercase address text:</p><div class="hash-byte-grid output-byte-grid">${byteGrid(parsed.checksumHash, parsed.checksumHash.length)}</div>`;
  return `<p>EIP-55 checksum hash: Keccak-256 of the lowercase address text (40 hex characters) · full 32-byte digest:</p><div class="hash-byte-grid output-byte-grid">${byteGrid(parsed.checksumHash, parsed.checksumHash.length)}</div><p>This EIP-55 digest is for address-letter casing. It is not the Keccak digest of the public key used to create the address; that original digest cannot be recovered from the 20-byte address alone.</p>`;
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

const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

function concatBytes(...parts) {
  const output = new Uint8Array(parts.reduce((all, part) => all + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function bytesToBigInt(bytes) {
  return BigInt(`0x${hex(bytes)}`);
}

function bigIntToBytes(value) {
  const bytes = new Uint8Array(32);
  let number = value;
  for (let index = 31; index >= 0; index -= 1) {
    bytes[index] = Number(number & 0xffn);
    number >>= 8n;
  }
  return bytes;
}

function hash160(bytes) {
  return ripemd160(sha256(bytes));
}

function base58Check(versionedPayload) {
  const checksum = sha256(sha256(versionedPayload)).slice(0, 4);
  const bytes = concatBytes(versionedPayload, checksum);
  return { address: base58.encode(bytes), payload: versionedPayload, checksum, bytes };
}

function taggedHash(tag, message) {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagHash, tagHash, message));
}

function taprootDetails(privateKey) {
  const scalar = bytesToBigInt(privateKey);
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const yIsOdd = (publicKey[64] & 1) === 1;
  const evenScalar = yIsOdd ? SECP256K1_ORDER - scalar : scalar;
  const internalPrivateKey = bigIntToBytes(evenScalar);
  const internalPublicKey = secp256k1.getPublicKey(internalPrivateKey, true);
  const internalX = internalPublicKey.slice(1);
  const tweakHash = taggedHash('TapTweak', internalX);
  const tweak = bytesToBigInt(tweakHash);
  if (tweak >= SECP256K1_ORDER) throw new Error('Invalid BIP-341 TapTweak scalar');
  const outputScalar = (evenScalar + tweak) % SECP256K1_ORDER;
  if (outputScalar === 0n) throw new Error('Invalid BIP-341 tweaked private scalar');
  const outputPrivateKey = bigIntToBytes(outputScalar);
  const outputPublicKey = secp256k1.getPublicKey(outputPrivateKey, true);
  const outputX = outputPublicKey.slice(1);
  return {
    internalX,
    internalPrivateKey,
    tweakHash,
    tweak: bigIntToBytes(tweak),
    outputPrivateKey,
    outputPublicKey,
    outputX,
    address: bech32m.encode('bc', [1, ...bech32m.toWords(outputX)]),
  };
}

function exportTextFile(filename, contents) {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    tronShaFirst: () => hex(wallet.tronShaFirst),
    tronShaSecond: () => hex(wallet.tronShaSecond),
    tronChecksum: () => hex(wallet.tronChecksum),
    tronBase58Bytes: () => hex(wallet.tronBase58Bytes),
    btcHash160: () => hex(wallet.btcHash160),
    btcSha256: () => hex(wallet.btcSha256),
    btcPayload: () => hex(wallet.btcPayload),
    btcChecksum: () => hex(wallet.btcChecksum),
    btcRedeemScript: () => hex(wallet.btcRedeemScript),
    btcScriptHash: () => hex(wallet.btcScriptHash),
    taprootInternalX: () => hex(wallet.taprootData?.internalX),
    taprootTweakHash: () => hex(wallet.taprootData?.tweakHash),
    taprootTweak: () => hex(wallet.taprootData?.tweak),
    taprootOutputX: () => hex(wallet.taprootData?.outputX),
    taprootOutputPrivateKey: () => hex(wallet.taprootData?.outputPrivateKey),
    keccak: () => hex(wallet.keccakHash),
    addressBytes: () => hex(wallet.addressBytes),
    eip55Hash: () => hex(wallet.eip55Hash),
    searchPublicKey: () => hex(discreteLogResult?.parsed?.publicKey),
    searchKeyDigest: () => hex(discreteLogResult?.parsed?.keyKeccakHash),
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

function searchResultMarkup(result, network, searchLimitReached) {
  if (!result) return '<p class="dlog-placeholder">Enter an address or public key and run the appropriate local calculation.</p>';
  if (result.status === 'invalid') return `<div class="dlog-warning result-error"><strong>Invalid ${network.label} input.</strong> ${escapeHtml(result.reason)}</div>`;
  if (result.status === 'publicKey') return `<div class="dlog-results"><div><label>INPUT · VALIDATED SECP256K1 PUBLIC KEY</label><code class="dlog-address-value">${hex(result.parsed.publicKey)}</code>${copyButton('searchPublicKey', 'Copy public key')}<p>Point validation succeeded. The app uses only this public key; it does not need or derive the private key.</p></div><div><label>FULL ADDRESS-GENERATION DIGEST · 32 BYTES</label><p>Keccak-256(public key body X || Y):</p><div class="hash-byte-grid output-byte-grid">${byteGrid(result.parsed.keyKeccakHash, result.parsed.keyKeccakHash.length)}</div>${copyButton('searchKeyDigest', 'Copy 32-byte digest')}<p>The final 20 bytes are the address payload:</p><code class="dlog-address-value">${hex(result.parsed.bytes)}</code></div><div><label>DERIVED ETHEREUM ADDRESS</label><code class="dlog-address-value">${result.parsed.display}</code>${networkAddressDetails(result.parsed, network)}<p>No private-scalar search was run; this is the direct public-key-to-address calculation.</p></div></div>`;
  return `<div class="dlog-results"><div><label>INPUT · ${network.shortLabel} ADDRESS BYTES</label><code class="dlog-address-value">${escapeHtml(result.parsed.display)}</code><div class="hash-byte-grid address-byte-grid">${byteGrid(result.parsed.bytes)}</div>${networkAddressDetails(result.parsed, network)}</div><div><label>SEARCH · REAL SECP256K1 CANDIDATES</label><p>${result.foundScalar ? `Match found at private scalar d=${result.foundScalar}; this candidate reproduces the entered address.` : `No match in scalars ${result.startScalar}–${result.lastScalar}; ${result.totalTested.toLocaleString()} candidates tested in total.`}</p><p>A miss excludes only the tested interval. Scalars outside it remain untested; request another batch to continue the next range.</p><div class="search-progress"><span style="width:100%"></span></div><p>Latest batch: ${result.trials}/${result.trials} candidates · ${result.elapsedMs.toFixed(2)} ms · ${result.candidatesPerSecond.toFixed(0)} candidates/s. Tested through scalar ${result.totalTested.toLocaleString()} of ${SEARCH_SCALAR_LIMIT.toLocaleString()} max.</p><p>Address-preimage work estimate: average ≈2<sup>${result.addressBits}</sup> candidate addresses${result.addressBits === 255 ? ' (Taproot x-only output space).' : ' (20-byte address output).'} At the latest measured rate, roughly 10<sup>${result.log10ExpectedYears.toFixed(1)}</sup> years. Extrapolation only—not practical private-key recovery or a full secp256k1 attack.</p>${result.foundPublicKey ? `<p>Matched public key: <code class="dlog-address-value">${result.foundPublicKey}</code></p>` : '<p>The target public key was not found in this bounded interval.</p>'}${searchLimitReached ? '<p><strong>The app’s maximum scalar bound has been reached; no further candidates will be tested.</strong></p>' : ''}</div><div><label>THIS BATCH · BOUNDARY CANDIDATES</label><p>d=${result.startScalar} → <code>${result.firstCandidateAddress}</code></p><p>d=${result.lastScalar} → <code>${result.lastCandidateAddress}</code></p><p>These are real addresses computed under ${network.label} rules.</p></div></div>`;
}

function scanCardMarkup() {
  return `
    <section class="scan-card" id="scan-card">
      <div class="scan-heading"><div><span class="eyebrow">SERVER-SIDE WALLET SCAN · EC2 / LAMBDA</span><h2>Upload wallets, scan them on the server</h2></div></div>
      <p class="scan-intro">Upload a file of seeds, mnemonics, or private keys (one per line in <strong>.txt</strong>/<strong>.csv</strong>, or a JSON array). It is uploaded and a server job derives each wallet’s addresses for every supported network, fetches its <strong>holdings</strong> and <strong>USD value</strong>, and shows live progress. Empty wallets are hidden once the scan finishes; click a wallet’s <em>Export addr + seed</em> to download its address and seed phrase (sensitive).</p>
      <div class="scan-controls">
        <label class="file-drop" for="scan-file">
          <input id="scan-file" type="file" accept=".txt,.csv,.json,text/plain,application/json" hidden>
          <span class="file-drop-inner">${pendingFile ? escapeHtml(pendingFile.name) : 'Choose a <strong>.txt</strong> / <strong>.csv</strong> / <strong>.json</strong> file'}</span>
        </label>
        <button class="action-button" id="scan-start" type="button" ${pendingFile ? '' : 'disabled'}>Scan on server<span aria-hidden="true">↗</span></button>
      </div>
      <div class="scan-status" id="scan-status"></div>
      <div class="scan-results" id="scan-results"></div>
    </section>`;
}

function setScanStatus() {
  const el = document.querySelector('#scan-status');
  if (!el) return;
  const map = {
    idle: { cls: '', text: 'Choose a file and press “Scan on server”.' },
    uploading: { cls: 'is-busy', text: 'Uploading file…' },
    queued: { cls: 'is-busy', text: 'File uploaded — waiting for the scan to start…' },
    processing: { cls: 'is-busy', text: `Scanning… ${scanState.processed} / ${scanState.total} processed` },
    done: { cls: 'is-done', text: `Scan complete — ${scanState.results.filter((r) => r.valid).length} valid wallet(s) of ${scanState.results.length} entries.` },
    error: { cls: 'is-error', text: `Error: ${escapeHtml(scanState.error || 'unknown')}` },
  };
  const s = map[scanState.status] || { cls: '', text: '' };
  const pct = scanState.total ? Math.round((scanState.processed / scanState.total) * 100) : 0;
  const bar = scanState.status === 'processing' ? `<div class="scan-progress"><span style="width:${pct}%"></span></div>` : '';
  el.className = `scan-status ${s.cls}`;
  el.innerHTML = `${s.text}${bar}`;
}

function fmtUsd(value) {
  if (value == null) return '—';
  return `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function fmtAmt(value) {
  if (value == null) return '—';
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function walletHasFunds(result) {
  if (!result.balances) return true; // unknown -> keep
  return Object.values(result.balances).some((b) => b && (b.balance > 0 || (b.tokens && b.tokens.some((t) => t && t.balance > 0))));
}

function renderScanResults() {
  const el = document.querySelector('#scan-results');
  if (!el) return;
  if (!scanState.results.length) { el.innerHTML = ''; return; }

  const hideEmpty = scanState.hideEmpty !== false;
  const visible = scanState.results.filter((r) => {
    if (!r.valid) return true;            // always keep invalid/unknown rows
    if (scanState.status !== 'done') return true; // don't filter mid-scan
    return !hideEmpty || walletHasFunds(r); // hide confirmed-empty wallets when done
  });

  const totalValue = scanState.results
    .filter(walletHasFunds)
    .reduce((sum, r) => sum + (r.totalValueUsd || 0), 0);
  const anyMock = scanState.results.some((r) => r.mocked);
  const fundedCount = visible.filter((r) => r.valid && walletHasFunds(r)).length;

  const summary = `<div class="scan-summary">
    <div class="scan-summary-line"><b>${fundedCount}</b> wallet(s) with funds · total value <b>${fmtUsd(totalValue)}</b></div>
    ${anyMock ? '<div class="scan-mock-note">Demo balances (mock). Set MOCK_BALANCES=0 and deploy the Lambda (which has internet) for live holdings + prices.</div>' : ''}
    <label class="scan-toggle"><input type="checkbox" id="scan-hide-empty" ${hideEmpty ? 'checked' : ''}> Hide empty wallets</label>
  </div>`;

  const rows = visible.map((r, i) => {
    const statusBadge = r.valid ? '<span class="scan-ok">VALID</span>' : (r.kind === 'blank' ? '' : '<span class="scan-bad">INVALID</span>');
    const note = r.valid ? '' : (r.reason ? `<small class="scan-reason">${escapeHtml(r.reason)}</small>` : '');
    let assets = '—';
    if (r.balances) {
      const parts = [];
      for (const [id, b] of Object.entries(r.balances)) {
        if (!b) continue;
        if (b.error) { parts.push(`${b.symbol}: <span class="scan-err">${escapeHtml(b.error)}</span>`); continue; }
        if (b.balance > 0) parts.push(`<span class="scan-asset"><b>${escapeHtml(b.symbol)}</b> ${fmtAmt(b.balance)} <span class="scan-val">(${fmtUsd(b.valueUsd)})</span></span>`);
        if (b.tokens && b.tokens.length) {
          for (const t of b.tokens) {
            if (t.error) { parts.push(`${t.symbol}: <span class="scan-err">${escapeHtml(t.error)}</span>`); continue; }
            if (t.balance > 0) parts.push(`<span class="scan-asset scan-token"><b>${escapeHtml(t.symbol)}</b> ${fmtAmt(t.balance)} <span class="scan-val">(${fmtUsd(t.valueUsd)})</span></span>`);
          }
        }
      }
      assets = parts.length ? parts.join(' ') : '<span class="scan-empty">empty</span>';
    }
    const exportBtn = r.valid ? `<button class="copy-button scan-export" data-export-index="${r.index}" type="button">Export addr + seed</button>` : '';
    return `<tr>
      <td class="scan-idx">${i + 1}</td>
      <td class="scan-input"><code>${escapeHtml(r.input || '')}</code>${note}</td>
      <td>${statusBadge}</td>
      <td class="scan-assets"><button class="scan-assets-open" data-detail-index="${r.index}" type="button" ${r.valid ? '' : 'disabled'} aria-label="View ${escapeHtml(r.input || 'wallet')} assets">${assets}<span class="scan-view-hint">View / export</span></button></td>
      <td class="scan-total">${r.valid ? fmtUsd(r.totalValueUsd) : '—'}</td>
      <td>${exportBtn}</td>
    </tr>`;
  }).join('');

  const download = scanState.status === 'done' ? `<div class="scan-download"><button class="copy-button" id="scan-download" type="button">Download results (JSON)</button></div>` : '';
  el.innerHTML = `${download}${summary}<div class="scan-table-wrap"><table class="scan-table"><thead><tr><th>#</th><th>Wallet (seed / private key)</th><th>Status</th><th>Assets · balance · USD value</th><th>Wallet value</th><th>Export</th></tr></thead><tbody>${rows}</tbody></table></div>`;

  document.querySelector('#scan-download')?.addEventListener('click', downloadScanResults);
  document.querySelector('#scan-hide-empty')?.addEventListener('change', (event) => {
    scanState.hideEmpty = event.target.checked;
    renderScanResults();
  });
  el.querySelectorAll('[data-export-index]').forEach((node) => node.addEventListener('click', () => exportWallet(Number(node.dataset.exportIndex))));
  el.querySelectorAll('[data-detail-index]').forEach((node) => node.addEventListener('click', () => showWalletDetails(Number(node.dataset.detailIndex))));
}

function showWalletDetails(index) {
  const result = scanState.results[index];
  if (!result || !result.valid) return;
  document.querySelector('#wallet-details-dialog')?.remove();
  const assetRows = [];
  for (const [network, balance] of Object.entries(result.balances || {})) {
    if (balance?.balance > 0) assetRows.push(`<li><b>${escapeHtml(balance.symbol)}</b> ${fmtAmt(balance.balance)} (${fmtUsd(balance.valueUsd)}) · ${escapeHtml(network)}</li>`);
    for (const token of balance?.tokens || []) {
      if (token?.balance > 0) assetRows.push(`<li><b>${escapeHtml(token.symbol)}</b> ${fmtAmt(token.balance)} (${fmtUsd(token.valueUsd)}) · ${escapeHtml(network)}</li>`);
    }
  }
  const addressRows = Object.entries(result.addresses || {}).map(([network, address]) => `<li><b>${escapeHtml(network)}</b><code>${escapeHtml(address)}</code></li>`).join('');
  const dialog = document.createElement('dialog');
  dialog.id = 'wallet-details-dialog';
  dialog.className = 'wallet-details-dialog';
  dialog.innerHTML = `<div class="wallet-details-heading"><div><span class="eyebrow">ASSET DETAILS</span><h2>${fmtUsd(result.totalValueUsd)} total</h2></div><button type="button" class="reverse-toggle" data-close-details>Close</button></div><h3>Holdings</h3><ul>${assetRows.length ? assetRows.join('') : '<li>No reported assets with a balance.</li>'}</ul><h3>Wallet addresses</h3><ul class="wallet-address-list">${addressRows}</ul><p class="hash-footnote">Exporting includes sensitive recovery material. Anyone with the seed phrase or private key can control the wallet.</p><button type="button" class="action-button" data-detail-export>Export address + seed</button>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('[data-close-details]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.querySelector('[data-detail-export]').addEventListener('click', () => exportWallet(index));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
}

function exportWallet(index) {
  const result = scanState.results[index];
  if (!result || !result.valid) return;
  const confirmed = window.confirm('This TXT file contains the wallet’s seed phrase / private key AND its addresses. It is sensitive — keep it private. Continue?');
  if (!confirmed) return;
  const lines = ['WALLET EXPORT (educational / test data only)', `seed-or-private-key: ${result.input}`];
  if (result.addresses) {
    for (const [id, addr] of Object.entries(result.addresses)) lines.push(`${id}: ${addr}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'wallet-export.txt';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadScanResults() {
  const blob = new Blob([JSON.stringify(scanState.results, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'wallet-scan-results.json';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function startScan() {
  if (!pendingFile) return;
  scanState = { jobId: null, status: 'uploading', total: 0, processed: 0, results: [], error: null, hideEmpty: true };
  setScanStatus();
  renderScanResults();
  try {
    const fd = new FormData();
    fd.append('file', pendingFile, pendingFile.name);
    const res = await fetch(`${API_BASE}/api/scan`, { method: 'POST', body: fd });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      scanState.status = 'error';
      scanState.error = e.error || `HTTP ${res.status}`;
      setScanStatus();
      return;
    }
    const data = await res.json();
    scanState.jobId = data.jobId;
    if (data.uploadUrl) {
      scanState.status = 'queued';
      setScanStatus();
      const put = await fetch(data.uploadUrl, { method: 'PUT', body: pendingFile, headers: { 'content-type': 'application/octet-stream' } });
      if (!put.ok) {
        scanState.status = 'error';
        scanState.error = 'S3 upload failed';
        setScanStatus();
        return;
      }
    }
    pollScan(data.jobId);
  } catch (err) {
    scanState.status = 'error';
    scanState.error = err.message;
    setScanStatus();
  }
}

async function pollScan(jobId) {
  try {
    const res = await fetch(`${API_BASE}/api/scan/${jobId}`);
    if (!res.ok) return;
    const job = await res.json();
    scanState.status = job.status;
    scanState.total = job.total || 0;
    scanState.processed = job.processed || 0;
    scanState.results = job.results || [];
    scanState.error = job.error || null;
    setScanStatus();
    renderScanResults();
    if (job.status === 'done' || job.status === 'error') return;
    setTimeout(() => pollScan(jobId), 800);
  } catch {
    setTimeout(() => pollScan(jobId), 1500);
  }
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
    ${activeNetwork.family === 'bitcoin' || activeNetwork.family === 'bnbBeacon' ? `<div class="value-row"><div><label>Compressed public key · 33 bytes (used by ${activeNetwork.label})</label><code>${spacedHex(wallet.compressedPublicKey)}</code></div>${copyButton('compressedPublicKey')}</div>` : ''}` : `<p class="locked-note">Derive the ${activeNetwork.label} account at <code>${activeNetwork.path}</code>, then compute its secp256k1 public key.</p>`;

  let addressBody;
  if (wallet.stage < 5) {
    addressBody = `<p class="locked-note">Derive the public key, then apply the ${activeNetwork.label} address encoding.</p>`;
  } else if (activeNetwork.family === 'bitcoin' && activeNetwork.format === 'p2wpkh') {
    addressBody = `
      <p class="step-explanation">Bitcoin native SegWit P2WPKH uses the compressed secp256k1 public key. SHA-256 then RIPEMD-160 produces a 20-byte witness program. Bech32 encodes witness version 0 and the mainnet HRP <code>bc</code>.</p>
      <div class="hash-block"><div class="hash-block-heading"><label>INPUT · COMPRESSED PUBLIC KEY · 33 BYTES</label>${copyButton('compressedPublicKey', 'Copy key')}</div><div class="hash-byte-grid">${byteGrid(wallet.compressedPublicKey)}</div></div>
      <div class="value-row"><div><label>SHA-256(compressed public key)</label><code>${spacedHex(wallet.btcSha256)}</code></div></div>
      <div class="value-row"><div><label>HASH160 · RIPEMD-160(SHA-256) · 20 bytes</label><code>${spacedHex(wallet.btcHash160)}</code></div>${copyButton('addressBytes', 'Copy program')}</div>
      <div class="hash-params"><span>WITNESS <b>version 0</b></span><span>HRP <b>bc</b></span><span>CHECKSUM <b>Bech32</b></span></div>
      <div class="hash-byte-grid address-byte-grid">${byteGrid(wallet.btcHash160)}</div>
      <div class="address-output"><div><span class="mini-label">BITCOIN · NATIVE SEGWIT P2WPKH</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  } else if (activeNetwork.family === 'bitcoin' && activeNetwork.format === 'p2pkh') {
    addressBody = `
      <p class="step-explanation">Legacy Bitcoin P2PKH hashes the compressed public key with HASH160, prepends mainnet version byte <code>00</code>, appends a 4-byte double-SHA-256 checksum, then Base58Check encodes the 25 bytes.</p>
      <div class="value-row"><div><label>Compressed public key · 33 bytes</label><code>${spacedHex(wallet.compressedPublicKey)}</code></div>${copyButton('compressedPublicKey')}</div>
      <div class="value-row"><div><label>SHA-256(compressed public key)</label><code>${spacedHex(wallet.btcSha256)}</code></div></div>
      <div class="value-row"><div><label>HASH160 · 20 bytes</label><code>${spacedHex(wallet.btcHash160)}</code></div></div>
      <div class="value-row"><div><label>Payload · version 00 || HASH160 · 21 bytes</label><code>${spacedHex(wallet.btcPayload)}</code></div></div>
      <div class="value-row"><div><label>Base58Check checksum · 4 bytes</label><code>${spacedHex(wallet.btcChecksum)}</code></div></div>
      <div class="address-output"><div><span class="mini-label">BITCOIN · LEGACY P2PKH</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  } else if (activeNetwork.family === 'bitcoin' && activeNetwork.format === 'p2sh-p2wpkh') {
    addressBody = `
      <p class="step-explanation">Nested SegWit P2SH-P2WPKH creates redeem script <code>0014 || HASH160(compressed pubkey)</code>, then hashes that script with HASH160. Version <code>05</code> and a double-SHA-256 checksum are Base58Check encoded.</p>
      <div class="value-row"><div><label>Compressed public key · 33 bytes</label><code>${spacedHex(wallet.compressedPublicKey)}</code></div>${copyButton('compressedPublicKey')}</div>
      <div class="value-row"><div><label>HASH160(compressed public key)</label><code>${spacedHex(wallet.btcHash160)}</code></div></div>
      <div class="value-row"><div><label>Redeem script · 00 14 || witness program · 22 bytes</label><code>${spacedHex(wallet.btcRedeemScript)}</code></div></div>
      <div class="value-row"><div><label>HASH160(redeem script)</label><code>${spacedHex(wallet.btcScriptHash)}</code></div></div>
      <div class="value-row"><div><label>P2SH payload · version 05 || script hash · 21 bytes</label><code>${spacedHex(wallet.btcPayload)}</code></div></div>
      <div class="value-row"><div><label>Base58Check checksum · 4 bytes</label><code>${spacedHex(wallet.btcChecksum)}</code></div></div>
      <div class="address-output"><div><span class="mini-label">BITCOIN · NESTED SEGWIT P2SH-P2WPKH</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  } else if (activeNetwork.family === 'bitcoin' && activeNetwork.format === 'p2tr') {
    addressBody = `
      <p class="step-explanation">BIP-86 Taproot normalizes the x-only internal point to even Y, applies tagged <code>TapTweak</code>, adds tweak·G, then encodes the x-only output key as witness v1 with Bech32m.</p>
      <div class="value-row"><div><label>Internal x-only public key · 32 bytes</label><code>${spacedHex(wallet.taprootData.internalX)}</code></div></div>
      <div class="value-row"><div><label>TaggedHash(TapTweak, internal key)</label><code>${spacedHex(wallet.taprootData.tweakHash)}</code></div></div>
      <div class="value-row"><div><label>TapTweak scalar</label><code>${spacedHex(wallet.taprootData.tweak)}</code></div></div>
      <div class="value-row"><div><label>Tweaked output public key · compressed</label><code>${spacedHex(wallet.taprootData.outputPublicKey)}</code></div></div>
      <div class="value-row"><div><label>Witness v1 program · x-only output key · 32 bytes</label><code>${spacedHex(wallet.taprootData.outputX)}</code></div></div>
      <p class="step-explanation subtle">BIP-86 tweaked private scalar (sensitive; keep private): <code>${hex(wallet.taprootData.outputPrivateKey)}</code></p>
      <div class="address-output"><div><span class="mini-label">BITCOIN · TAPROOT P2TR · BECH32M</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  } else if (activeNetwork.family === 'tron') {
    addressBody = `
      <p class="step-explanation">TRON uses the uncompressed public key body (X || Y), Keccak-256, and the final 20 digest bytes. It prepends mainnet version byte <code>41</code>, appends the first 4 bytes of double-SHA-256 as a Base58Check checksum, then encodes the 25-byte result in Base58.</p>
      <div class="hash-block"><div class="hash-block-heading"><label>INPUT · PUBLIC KEY BODY · 64 BYTES</label>${copyButton('publicBody', 'Copy input')}</div><div class="hash-byte-grid input-byte-grid">${byteGrid(wallet.publicKey.slice(1))}</div></div>
      <div class="hash-block"><div class="hash-block-heading"><label>KECCAK-256 · FULL DIGEST · 32 BYTES</label></div><div class="hash-byte-grid output-byte-grid">${byteGrid(wallet.keccakHash, 12)}</div></div>
      <div class="value-row"><div><label>Address payload · version 0x41 || 20 address bytes · 21 bytes</label><code>${spacedHex(wallet.tronPayload)}</code></div>${copyButton('tronPayload')}</div>
      <div class="value-row"><div><label>SHA-256(payload) · 32 bytes</label><code>${spacedHex(wallet.tronShaFirst)}</code></div>${copyButton('tronShaFirst')}</div>
      <div class="value-row"><div><label>SHA-256(previous digest) · 32 bytes</label><code>${spacedHex(wallet.tronShaSecond)}</code></div>${copyButton('tronShaSecond')}</div>
      <div class="value-row"><div><label>Checksum · first 4 bytes of second SHA-256</label><code>${spacedHex(wallet.tronChecksum)}</code></div>${copyButton('tronChecksum')}</div>
      <div class="value-row"><div><label>Base58Check input · payload || checksum · 25 bytes</label><code>${spacedHex(wallet.tronBase58Bytes)}</code></div>${copyButton('tronBase58Bytes')}</div>
      <div class="address-output"><div><span class="mini-label">TRON MAINNET · BASE58CHECK</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
  } else if (activeNetwork.family === 'bnbBeacon') {
    addressBody = `
      <p class="step-explanation">BNB Beacon Chain (legacy BEP2, historical/reference profile) uses path <code>${activeNetwork.path}</code>. It hashes the compressed secp256k1 public key with SHA-256 then RIPEMD-160, and Bech32-encodes the 20-byte result with HRP <code>bnb</code>. This differs from EVM-compatible BNB Smart Chain.</p>
      <div class="value-row"><div><label>Compressed secp256k1 public key · 33 bytes</label><code>${spacedHex(wallet.compressedPublicKey)}</code></div>${copyButton('compressedPublicKey')}</div>
      <div class="value-row"><div><label>SHA-256(compressed public key)</label><code>${spacedHex(wallet.btcSha256)}</code></div></div>
      <div class="value-row"><div><label>RIPEMD-160 · 20-byte address payload</label><code>${spacedHex(wallet.btcHash160)}</code></div>${copyButton('addressBytes', 'Copy payload')}</div>
      <div class="hash-params"><span>HRP <b>bnb</b></span><span>ENCODING <b>Bech32</b></span><span>PAYLOAD <b>20 bytes</b></span></div>
      <div class="address-output"><div><span class="mini-label">BNB BEACON CHAIN · BECH32</span><strong>${wallet.address}</strong></div>${copyButton('address', 'Copy address')}</div>`;
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
        <article class="reverse-row blocked"><div class="reverse-step">06</div><div class="reverse-content"><div class="reverse-title"><strong>Address ← public key</strong><span class="recovery-tag no">NOT REVERSIBLE</span></div><div class="reverse-live"><label>Live address</label><code>${wallet.address}</code></div><p>${activeNetwork.family === 'bitcoin' ? (activeNetwork.format === 'p2wpkh' ? 'Bitcoin hashes the compressed public key with HASH160 and encodes the witness program using Bech32; there is no inverse to recover the public key.' : activeNetwork.format === 'p2pkh' ? 'Bitcoin Legacy hashes the compressed public key with HASH160, then adds Base58Check version and checksum; this does not reveal the public key.' : activeNetwork.format === 'p2sh-p2wpkh' ? 'Nested SegWit hashes a redeem script containing the witness program with HASH160 and Base58Check; the address alone reveals neither the script nor public key.' : 'Taproot encodes a tweaked x-only output key; the address does not reveal the internal key or private scalar.') : activeNetwork.family === 'bnbBeacon' ? 'BNB Beacon hashes the compressed public key with HASH160 and encodes it with Bech32; there is no inverse to recover the key.' : activeNetwork.family === 'tron' ? 'TRON Keccak-hashes the public-key body, keeps 20 bytes, then adds a version and Base58Check checksum; this does not reveal the key.' : 'Keccak-256 hashes the public-key body and the address keeps only 20 digest bytes. There is no inverse formula to recover the public key from this value.'}</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">05</div><div class="reverse-content"><div class="reverse-title"><strong>Public key ← private key</strong><span class="recovery-tag no">NOT PRACTICAL</span></div><div class="reverse-live"><label>Live public key</label><code>${shortHex(wallet.publicKey, 18, 12)}</code></div><p>The public key is <code>Q = d × G</code> on secp256k1. Finding <code>d</code> from <code>Q</code> requires solving the elliptic-curve discrete-log problem.</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">04</div><div class="reverse-content"><div class="reverse-title"><strong>Child key ← master node + path</strong><span class="recovery-tag no">PATH MATTERS</span></div><div class="reverse-live"><label>Path used</label><code>${activeNetwork.path}</code><label class="second-live-label">Live child key</label><code>${shortHex(wallet.account.privateKey, 18, 12)}</code></div><p>BIP-32 derives a child using HMAC-SHA512 and the selected path. The address does not encode that path. A child key alone lacks the parent chain code; hardened levels (${pathSegments.filter((segment) => segment.endsWith("'")).map((segment) => segment.replace("'", '′')).join(', ')}) also block deriving ancestors.</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">03</div><div class="reverse-content"><div class="reverse-title"><strong>Master node ← BIP-39 seed</strong><span class="recovery-tag no">NOT PRACTICAL</span></div><div class="reverse-live"><label>Master private · IL</label><code>${shortHex(wallet.master.privateKey, 18, 12)}</code><label class="second-live-label">Master chain code · IR</label><code>${shortHex(wallet.master.chainCode, 18, 12)}</code></div><p>BIP-32 creates these with HMAC-SHA512 using the key <code>Bitcoin seed</code>. The master node is derived from the seed; it does not contain a reversible copy of it.</p></div></article>
        <article class="reverse-row blocked"><div class="reverse-step">02</div><div class="reverse-content"><div class="reverse-title"><strong>Seed ← mnemonic + passphrase</strong><span class="recovery-tag no">CANDIDATES ONLY</span></div><div class="reverse-live"><label>Live seed · abbreviated</label><code>${shortHex(wallet.seed, 20, 12)}</code><label class="second-live-label">Passphrase used</label><code>${passphrase ? 'non-empty · hidden' : 'empty'}</code></div><p>PBKDF2-HMAC-SHA512 produces a 512-bit seed. It is not an encrypted copy of the words. You can test a guessed phrase and passphrase by running forward and comparing, but cannot extract the original from the seed.</p></div></article>
        <article class="reverse-row reversible"><div class="reverse-step">01</div><div class="reverse-content"><div class="reverse-title"><strong>Mnemonic → entropy</strong><span class="recovery-tag yes">REVERSIBLE</span></div><div class="reverse-live"><label>Live phrase</label><code>${wallet.phrase}</code><label class="second-live-label">Recovered entropy · matches original: ${entropyRoundTripMatches ? 'YES' : 'NO'}</label><code>${spacedHex(recoveredEntropy)}</code></div><p>This is the exception: the 12 word indices encode the 128 entropy bits plus a 4-bit checksum. BIP-39 can decode the phrase back to the exact entropy and verify its checksum.</p></div></article>
      </div>
      <div class="takeaway"><strong>Why address → phrase search is not practical</strong><span>With no phrase words known, a search must try up to 2<sup>128</sup> valid mnemonics (and know the passphrase and derivation path), derive each address, then compare. This is not a useful workload for the $85 EC2 budget.</span></div>
    </section>` : '';
  const previousSearchMatchesInput = discreteLogResult?.status === 'valid'
    && discreteLogResult.networkId === selectedNetworkId
    && discreteLogResult.addressInput === (labAddressInput ?? wallet.address);
  const nextSearchScalar = previousSearchMatchesInput && !discreteLogResult.foundScalar ? discreteLogResult.lastScalar + 1 : 1;
  const canContinueSearch = previousSearchMatchesInput && !discreteLogResult.foundScalar && nextSearchScalar <= SEARCH_SCALAR_LIMIT;
  const searchLimitReached = previousSearchMatchesInput && !discreteLogResult.foundScalar && discreteLogResult.lastScalar >= SEARCH_SCALAR_LIMIT;
  const nextSearchEnd = Math.min(nextSearchScalar + SEARCH_BATCH_SIZE - 1, SEARCH_SCALAR_LIMIT);
  const publicKeyInputEntered = activeNetwork.family === 'evm' && looksLikeEvmPublicKey(labAddressInput ?? '');
  const searchButtonLabel = discreteLogProgress
    ? autoSearchEnabled ? 'Automatic search running…' : discreteLogProgress.auto ? 'Stopping after current block…' : 'Search running…'
    : publicKeyInputEntered
      ? 'Calculate full Keccak-256 from public key'
      : canContinueSearch
      ? `Search next batch · ${nextSearchScalar}–${nextSearchEnd}`
      : searchLimitReached
        ? 'Maximum bounded range reached'
        : discreteLogResult?.foundScalar
          ? 'Start again from scalar 1'
          : `Run ${SEARCH_BATCH_SIZE}-candidate ${activeNetwork.shortLabel} search`;
  const discreteLogLab = wallet.stage >= 5 ? `
    <section class="backward-panel dlog-panel">
      <div class="backward-heading"><div><span class="eyebrow">ADDRESS SEARCH · LOCAL ONLY</span><h3>Inspect a ${activeNetwork.label} address or public key</h3></div><span class="live-example">${SEARCH_BATCH_SIZE} PER BATCH · ${SEARCH_SCALAR_LIMIT.toLocaleString()} TOTAL CAP</span></div>
      <p class="backward-intro">Enter an address to test consecutive bounded scalar batches, or paste a public key to calculate its full address-generation Keccak-256 digest directly. Public-key input does not run a scalar search. Address batches remain capped at 1–${SEARCH_SCALAR_LIMIT.toLocaleString()}.</p>
      <div class="dlog-address-control"><label for="lab-address">${activeNetwork.label} address or public key</label><input id="lab-address" type="text" spellcheck="false" autocomplete="off" placeholder="${addressPlaceholder()}" value="${escapeHtml(labAddressInput ?? wallet.address)}" ${discreteLogProgress ? 'disabled' : ''}><small>${addressInputHint()}</small>${labAddressInput?.trim() ? '<button class="reverse-toggle" id="export-public-address" type="button">Export public address</button>' : ''}</div>
      <div class="dlog-warning"><strong>This is a bounded address search—not a full secp256k1 break.</strong> An address alone does not reveal its public key or private key. If you provide a public key, the app can compute its address digest, but cannot derive the private key. Address search runs in batches of ${SEARCH_BATCH_SIZE} and cannot test beyond scalar ${SEARCH_SCALAR_LIMIT.toLocaleString()}. Everything runs in this browser; automatic search requires this tab/device to stay awake and is not an EC2 background job.</div>
      <div class="dlog-actions"><button class="action-button dlog-button" id="run-dlog-lab" type="button" ${discreteLogProgress || searchLimitReached ? 'disabled' : ''}>${searchButtonLabel}<span aria-hidden="true">↗</span></button><button class="dlog-auto-button" id="run-auto-search" type="button" ${discreteLogProgress || searchLimitReached || publicKeyInputEntered ? 'disabled' : ''}>Auto-search ${canContinueSearch ? `${nextSearchScalar}–${SEARCH_SCALAR_LIMIT.toLocaleString()}` : `1–${SEARCH_SCALAR_LIMIT.toLocaleString()}`}<span aria-hidden="true">↗</span></button></div>
      ${discreteLogProgress ? `<div class="dlog-live-progress" role="status" aria-live="polite"><b>Testing scalars ${discreteLogProgress.startScalar}–${discreteLogProgress.endScalar}</b><div class="search-progress"><span style="width:${100 * discreteLogProgress.completed / discreteLogProgress.trials}%"></span></div><p>${discreteLogProgress.completed}/${discreteLogProgress.trials} ${discreteLogProgress.auto ? 'in this automatic run' : 'in this batch'} · ${discreteLogProgress.elapsedMs.toFixed(2)} ms elapsed · ${discreteLogProgress.candidatesPerSecond.toFixed(0)} candidates/s measured. Overall tested-through scalar: ${discreteLogProgress.startScalar + discreteLogProgress.completed - 1} of ${SEARCH_SCALAR_LIMIT.toLocaleString()} max.</p>${discreteLogProgress.auto && autoSearchEnabled ? '<button class="dlog-stop-button" id="stop-auto-search" type="button">Stop after this progress block (max 4,096 candidates)</button>' : ''}</div>` : searchResultMarkup(discreteLogResult, activeNetwork, searchLimitReached)}
      <p class="step-explanation subtle">${publicKeyInputEntered ? 'For a supplied public key, validate the secp256k1 point, compute Keccak-256 of X || Y, and take the final 20 bytes for the Ethereum address. No private key is derived.' : 'For each candidate d, compute Q=dG on secp256k1, apply the selected network’s public-key/address encoding, then compare. A miss rules out only the exact interval tested—not any private scalars beyond it and not the curve.'}</p>
    </section>` : '';

  app.innerHTML = `
    <header class="topbar"><a class="brand" href="#" aria-label="Seedlab home"><span class="brand-mark">S</span><span>seedlab</span></a><div class="topbar-meta"><span class="live-dot"></span> DERIVATION LAB <span class="topbar-divider">/</span> TEST DATA ONLY</div></header>
    <main class="page-shell">
      <div class="page-heading"><div><div class="eyebrow">WALLET BUILD · 5 CALCULATIONS</div><h1>Trace a wallet to its address.</h1><p>Run each calculation in order. Every value is generated in this browser session.</p></div><div class="session-chip"><span class="session-dot"></span>${wallet.stage ? `STEP ${String(Math.min(wallet.stage + 1, 5)).padStart(2, '0')} OF 05` : 'READY TO START'}</div></div>
      <div class="security-banner"><span class="alert-mark">!</span><p><strong>Public HTTP learning demo.</strong> The local derivation lab keeps secret values in this browser. The “Scan on server” upload sends your file to the server (S3 + Lambda) for scanning and is <strong>not</strong> stored permanently — only send test data, never real wallet secrets.</p></div>
      <div class="layout-grid">
        <div class="lesson-column">
          ${scanCardMarkup()}
          <section class="setup-card"><div class="setup-copy"><span class="eyebrow">START HERE</span><h2>Make a fresh demo wallet</h2><p>Uses browser cryptographic randomness. Nothing is saved or sent to EC2.</p></div><div class="setup-controls"><label for="network-select">Derive an address for</label><select id="network-select">${Object.entries(NETWORKS).map(([id, network]) => `<option value="${id}" ${selectedNetworkId === id ? 'selected' : ''}>${network.label}</option>`).join('')}</select><small class="network-note">Includes BTC Legacy, Nested SegWit, Native SegWit and Taproot; TRON; BNB Smart Chain (EVM) and BNB Beacon (BEP2).</small><label for="passphrase">Optional BIP-39 passphrase</label><input id="passphrase" type="password" autocomplete="new-password" placeholder="Leave blank for no passphrase" value="${passphrase.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}" ${wallet.stage ? 'disabled' : ''}><small>${wallet.stage ? 'Locked for this derivation; reset to change it.' : 'Case-sensitive. It creates a different wallet.'}</small><button class="action-button generate-button" id="generate">${wallet.stage ? 'Generate another demo wallet' : 'Generate demo wallet'}<span aria-hidden="true">↗</span></button></div></section>
          <div class="steps-heading"><div><span class="eyebrow">THE PIPELINE</span><h2>Five steps, one address</h2></div><div class="steps-actions">${wallet.stage >= 5 ? `<button class="reverse-toggle" id="backward-toggle">${backwardOpen ? 'Hide backward trace' : 'Trace backward'}</button>` : ''}${wallet.stage ? '<button class="reset-button" id="reset">Reset session</button>' : ''}</div></div>
          ${stepCard({ number: '01', title: 'Entropy → mnemonic', caption: 'Create randomness and encode twelve words', step: 1, body: entropyBody, action: 'Generate 128-bit entropy & phrase' })}
          ${stepCard({ number: '02', title: 'Mnemonic → seed', caption: 'PBKDF2-HMAC-SHA512 · BIP-39', step: 2, body: seedBody, action: 'Derive 512-bit seed' })}
          ${stepCard({ number: '03', title: 'Seed → master node', caption: 'HMAC-SHA512 · BIP-32', step: 3, body: masterBody, action: 'Create BIP-32 master node' })}
          ${stepCard({ number: '04', title: `Master node → ${activeNetwork.label} keypair`, caption: `${activeNetwork.path.split('/')[1].replaceAll("'", '′')} path · secp256k1`, step: 4, body: accountBody, action: `Derive ${activeNetwork.label} account` })}
          ${stepCard({ number: '05', title: `${activeNetwork.label} public key → address`, caption: addressCaption(activeNetwork), step: 5, body: addressBody, action: `Compute ${activeNetwork.label} address` })}${wallet.stage >= 5 ? '<button class="reverse-toggle" id="export-seed-wallet" type="button">Export wallet details</button><p class="hash-footnote">Includes the address and BIP-39 recovery phrase. Anyone with the phrase can control the wallet; save it only somewhere secure.</p>' : ''}
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
  document.querySelector('#export-seed-wallet')?.addEventListener('click', () => exportTextFile('wallet-export.txt', `Wallet address: ${wallet.address}\nNetwork: ${activeNetwork.label}\nBIP-39 recovery phrase: ${wallet.phrase}\n\nSECURITY: This phrase controls the wallet. Keep it private.`));
  document.querySelector('#export-public-address')?.addEventListener('click', () => exportTextFile('public-address.txt', `Public address: ${(labAddressInput ?? '').trim()}\nNetwork: ${activeNetwork.label}\n`));
  document.querySelector('#reset')?.addEventListener('click', resetWallet);
  document.querySelector('#backward-toggle')?.addEventListener('click', () => {
    backwardOpen = !backwardOpen;
    render();
  });
  document.querySelector('#run-dlog-lab')?.addEventListener('click', () => { autoSearchEnabled = false; runDiscreteLogLab(); });
  document.querySelector('#run-auto-search')?.addEventListener('click', () => { autoSearchEnabled = true; runDiscreteLogLab(); });
  document.querySelector('#stop-auto-search')?.addEventListener('click', () => { autoSearchEnabled = false; });
  document.querySelector('#lab-address')?.addEventListener('input', (event) => {
    labAddressInput = event.target.value;
    if (discreteLogResult && labAddressInput.trim() !== discreteLogResult.addressInput) {
      discreteLogResult = null;
      document.querySelector('.dlog-results')?.remove();
      document.querySelector('.dlog-warning.result-error')?.remove();
    }
    const button = document.querySelector('#run-dlog-lab');
    if (button && !discreteLogProgress) {
      button.disabled = false;
      button.innerHTML = `${activeNetwork.family === 'evm' && looksLikeEvmPublicKey(labAddressInput) ? 'Calculate full Keccak-256 from public key' : `Run ${SEARCH_BATCH_SIZE}-candidate ${selectedNetwork().shortLabel} search`}<span aria-hidden="true">↗</span>`;
    }
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
  document.querySelector('#scan-file')?.addEventListener('change', (event) => {
    pendingFile = event.target.files && event.target.files[0];
    render();
  });
  document.querySelector('#scan-start')?.addEventListener('click', startScan);
  setScanStatus();
  renderScanResults();
}

function selectNetwork(event) {
  autoSearchEnabled = false;
  searchRunId += 1;
  discreteLogProgress = null;
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
  autoSearchEnabled = false;
  searchRunId += 1;
  discreteLogProgress = null;
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

function calculateAddressData(privateKey, networkId = selectedNetworkId) {
  const network = NETWORKS[networkId];
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const compressedPublicKey = secp256k1.getPublicKey(privateKey, true);
  if (network.family === 'bitcoin') {
    if (network.format === 'p2tr') {
      const taproot = taprootDetails(privateKey);
      return { publicKey, compressedPublicKey, address: taproot.address, addressBytes: taproot.outputX, taprootData: taproot };
    }
    const btcSha256 = sha256(compressedPublicKey);
    const btcHash160 = ripemd160(btcSha256);
    if (network.format === 'p2wpkh') {
      return { publicKey, compressedPublicKey, btcSha256, btcHash160, addressBytes: btcHash160, address: bech32.encode('bc', [0, ...bech32.toWords(btcHash160)]) };
    }
    if (network.format === 'p2pkh') {
      const checked = base58Check(new Uint8Array([0x00, ...btcHash160]));
      return { publicKey, compressedPublicKey, btcSha256, btcHash160, btcPayload: checked.payload, btcChecksum: checked.checksum, addressBytes: btcHash160, address: checked.address };
    }
    const btcRedeemScript = new Uint8Array([0x00, 0x14, ...btcHash160]);
    const btcScriptHash = hash160(btcRedeemScript);
    const checked = base58Check(new Uint8Array([0x05, ...btcScriptHash]));
    return { publicKey, compressedPublicKey, btcSha256, btcHash160, btcRedeemScript, btcScriptHash, btcPayload: checked.payload, btcChecksum: checked.checksum, addressBytes: btcScriptHash, address: checked.address };
  }
  if (network.family === 'bnbBeacon') {
    const btcHash160 = hash160(compressedPublicKey);
    return { publicKey, compressedPublicKey, btcHash160, addressBytes: btcHash160, address: bech32.encode('bnb', bech32.toWords(btcHash160)) };
  }
  const keccakHash = keccak_256(publicKey.slice(1));
  const addressBytes = keccakHash.slice(12);
  if (network.family === 'tron') {
    const tronPayload = new Uint8Array([0x41, ...addressBytes]);
    const tronShaFirst = sha256(tronPayload);
    const tronShaSecond = sha256(tronShaFirst);
    const tronChecksum = tronShaSecond.slice(0, 4);
    const tronBase58Bytes = concatBytes(tronPayload, tronChecksum);
    return { publicKey, compressedPublicKey, keccakHash, addressBytes, tronPayload, tronShaFirst, tronShaSecond, tronChecksum, tronBase58Bytes, address: base58.encode(tronBase58Bytes) };
  }
  const lowerAddress = hex(addressBytes);
  const eip55Hash = keccak_256(new TextEncoder().encode(lowerAddress));
  return { publicKey, compressedPublicKey, keccakHash, addressBytes, eip55Hash, address: checksumAddress(lowerAddress, eip55Hash) };
}

function parseBase58Check(input, version) {
  try {
    const decoded = base58.decode(input);
    if (decoded.length !== 25) return { valid: false, reason: 'Base58Check address must decode to 25 bytes.' };
    const payload = decoded.slice(0, 21);
    const checksum = decoded.slice(21);
    const expected = sha256(sha256(payload)).slice(0, 4);
    if (payload[0] !== version || hex(checksum) !== hex(expected)) return { valid: false, reason: 'Address version or Base58Check checksum is invalid for this profile.' };
    return { valid: true, display: input, normalized: input, bytes: payload.slice(1), payload, checksum };
  } catch {
    return { valid: false, reason: 'Address is not valid Base58Check.' };
  }
}

function parseEvmPublicKey(input) {
  const key = input.trim().replace(/\s+/g, '').replace(/^0x/i, '');
  if (!looksLikeEvmPublicKey(key)) return null;
  try {
    let bytes = Uint8Array.from(key.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
    if (bytes.length === 64) bytes = new Uint8Array([0x04, ...bytes]);
    const publicKey = secp256k1.Point.fromBytes(bytes).toBytes(false);
    const keccakHash = keccak_256(publicKey.slice(1));
    const addressBytes = keccakHash.slice(12);
    const lowerAddress = hex(addressBytes);
    const checksumHash = keccak_256(new TextEncoder().encode(lowerAddress));
    return {
      valid: true,
      inputKind: 'publicKey',
      publicKey,
      keyKeccakHash: keccakHash,
      display: checksumAddress(lowerAddress, checksumHash),
      normalized: `0x${lowerAddress}`,
      bytes: addressBytes,
      checksumHash,
    };
  } catch {
    return { valid: false, reason: 'Public key is not a valid secp256k1 point. Paste a 33-byte compressed or 64/65-byte uncompressed public key.' };
  }
}

function parseNetworkAddress(input, networkId = selectedNetworkId) {
  const network = NETWORKS[networkId];
  if (network.family === 'evm') {
    const publicKeyInput = parseEvmPublicKey(input);
    if (publicKeyInput) return publicKeyInput;
    if (!/^0x[0-9a-fA-F]{40}$/.test(input)) return { valid: false, reason: 'Enter a 0x-prefixed 20-byte address, or paste a valid compressed/uncompressed secp256k1 public key.' };
    const body = input.slice(2);
    const lower = body.toLowerCase();
    const mixed = body !== lower && body !== body.toUpperCase();
    const checksummed = checksumAddress(lower);
    if (mixed && checksummed !== input) return { valid: false, reason: 'Mixed-case address failed its EIP-55 checksum.' };
    return { valid: true, display: checksummed, normalized: `0x${lower}`, bytes: Uint8Array.from(lower.match(/.{2}/g), (byte) => Number.parseInt(byte, 16)), checksumHash: keccak_256(new TextEncoder().encode(lower)) };
  }
  if (network.family === 'tron') {
    const result = parseBase58Check(input, 0x41);
    return result.valid ? { ...result, payload: result.payload } : { valid: false, reason: 'Enter a valid TRON mainnet Base58Check address (version 0x41, usually starts with T).' };
  }
  if (network.family === 'bnbBeacon') {
    try {
      const decoded = bech32.decode(input);
      const bytes = Uint8Array.from(bech32.fromWords(decoded.words));
      if (decoded.prefix !== 'bnb' || bytes.length !== 20) return { valid: false, reason: 'Enter a BNB Beacon Chain Bech32 address (bnb prefix, 20-byte payload).' };
      return { valid: true, display: bech32.encode('bnb', bech32.toWords(bytes)), normalized: input.toLowerCase(), bytes };
    } catch {
      return { valid: false, reason: 'Enter a valid BNB Beacon Chain Bech32 address beginning with bnb1.' };
    }
  }
  if (network.format === 'p2pkh') return parseBase58Check(input, 0x00);
  if (network.format === 'p2sh-p2wpkh') return parseBase58Check(input, 0x05);
  try {
    if (network.format === 'p2tr') {
      const decoded = bech32m.decode(input);
      const program = Uint8Array.from(bech32m.fromWords(decoded.words.slice(1)));
      if (decoded.prefix !== 'bc' || decoded.words[0] !== 1 || program.length !== 32) return { valid: false, reason: 'Enter a Bitcoin mainnet Taproot P2TR address (bc1p…, witness v1, 32-byte output key).' };
      return { valid: true, display: bech32m.encode('bc', [1, ...bech32m.toWords(program)]), normalized: input.toLowerCase(), bytes: program };
    }
    const decoded = bech32.decode(input);
    const program = Uint8Array.from(bech32.fromWords(decoded.words.slice(1)));
    if (decoded.prefix !== 'bc' || decoded.words[0] !== 0 || program.length !== 20) return { valid: false, reason: 'Enter a Bitcoin mainnet native-SegWit P2WPKH address (bc1q…, witness v0, 20-byte program).' };
    return { valid: true, display: bech32.encode('bc', [0, ...bech32.toWords(program)]), normalized: input.toLowerCase(), bytes: program };
  } catch {
    return { valid: false, reason: network.format === 'p2tr' ? 'Enter a valid Bitcoin mainnet Bech32m Taproot address (bc1p…).': 'Enter a valid Bitcoin mainnet Bech32 P2WPKH address (bc1q…).' };
  }
}

function wipeTaprootData(data = wallet.taprootData) {
  data?.internalPrivateKey?.fill(0);
  data?.outputPrivateKey?.fill(0);
}

function deriveNetworkAddress() {
  wipeTaprootData();
  const data = calculateAddressData(wallet.account.privateKey);
  wallet.keccakHash = data.keccakHash ?? null;
  wallet.addressBytes = data.addressBytes;
  wallet.eip55Hash = data.eip55Hash ?? null;
  wallet.tronPayload = data.tronPayload ?? null;
  wallet.tronShaFirst = data.tronShaFirst ?? null;
  wallet.tronShaSecond = data.tronShaSecond ?? null;
  wallet.tronChecksum = data.tronChecksum ?? null;
  wallet.tronBase58Bytes = data.tronBase58Bytes ?? null;
  wallet.btcHash160 = data.btcHash160 ?? null;
  wallet.btcSha256 = data.btcSha256 ?? null;
  wallet.btcRedeemScript = data.btcRedeemScript ?? null;
  wallet.btcScriptHash = data.btcScriptHash ?? null;
  wallet.btcPayload = data.btcPayload ?? null;
  wallet.btcChecksum = data.btcChecksum ?? null;
  wallet.taprootData = data.taprootData ?? null;
  wallet.address = data.address;
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

async function runDiscreteLogLab() {
  const runAuto = autoSearchEnabled;
  const addressInput = document.querySelector('#lab-address')?.value.trim() ?? '';
  labAddressInput = addressInput;
  const parsed = parseNetworkAddress(addressInput);
  if (!parsed.valid) {
    autoSearchEnabled = false;
    discreteLogResult = { status: 'invalid', addressInput, reason: parsed.reason, networkId: selectedNetworkId };
    discreteLogProgress = null;
    render();
    return;
  }
  if (parsed.inputKind === 'publicKey') {
    autoSearchEnabled = false;
    discreteLogResult = { status: 'publicKey', addressInput, networkId: selectedNetworkId, parsed };
    discreteLogProgress = null;
    render();
    return;
  }

  const networkId = selectedNetworkId;
  const previous = discreteLogResult?.status === 'valid'
    && !discreteLogResult.foundScalar
    && discreteLogResult.networkId === networkId
    && discreteLogResult.addressInput === addressInput
    && discreteLogResult.lastScalar < SEARCH_SCALAR_LIMIT
    ? discreteLogResult
    : null;
  const startScalar = previous ? previous.lastScalar + 1 : 1;
  if (startScalar > SEARCH_SCALAR_LIMIT) {
    autoSearchEnabled = false;
    return;
  }
  const endScalar = runAuto ? SEARCH_SCALAR_LIMIT : Math.min(startScalar + SEARCH_BATCH_SIZE - 1, SEARCH_SCALAR_LIMIT);
  const plannedTrials = endScalar - startScalar + 1;
  const progressStride = runAuto ? 4096 : 16;
  const runId = ++searchRunId;
  const startedAt = performance.now();
  discreteLogResult = null;
  discreteLogProgress = { completed: 0, trials: plannedTrials, startScalar, endScalar, elapsedMs: 0, candidatesPerSecond: 0, networkId, parsed, auto: runAuto };
  render();
  let firstCandidateAddress = '';
  let lastCandidateAddress = '';
  let lastScalarTested = startScalar - 1;
  let testedCount = 0;
  let foundScalar = null;
  let foundPublicKey = null;
  const network = NETWORKS[networkId];
  const normalize = (address) => network.family === 'evm' || network.family === 'bnbBeacon' || (network.family === 'bitcoin' && ['p2wpkh', 'p2tr'].includes(network.format)) ? address.toLowerCase() : address;
  for (let candidate = startScalar; candidate <= endScalar; candidate += 1) {
    const privateKey = smallScalarBytes(candidate);
    const candidateData = calculateAddressData(privateKey, networkId);
    const candidateAddress = candidateData.address;
    if (candidate === startScalar) firstCandidateAddress = candidateAddress;
    lastCandidateAddress = candidateAddress;
    lastScalarTested = candidate;
    testedCount += 1;
    if (normalize(candidateAddress) === normalize(parsed.display)) {
      foundScalar = candidate;
      foundPublicKey = `0x${hex(candidateData.publicKey)}`;
    }
    privateKey.fill(0);
    if (candidateData.taprootData) wipeTaprootData(candidateData.taprootData);
    const completed = candidate - startScalar + 1;
    if (foundScalar || completed % progressStride === 0 || candidate === endScalar) {
      const elapsedMs = Math.max(performance.now() - startedAt, 0.01);
      discreteLogProgress = { completed, trials: plannedTrials, startScalar, endScalar, elapsedMs, candidatesPerSecond: completed * 1000 / elapsedMs, networkId, parsed, auto: runAuto };
      render();
      if (candidate < endScalar && !foundScalar) await new Promise((resolve) => setTimeout(resolve, 0));
      if (runId !== searchRunId) return;
      if (runAuto && !autoSearchEnabled) break;
    }
    if (foundScalar) break;
  }
  const elapsedMs = Math.max(performance.now() - startedAt, 0.01);
  const candidatesPerSecond = testedCount * 1000 / elapsedMs;
  const addressBits = NETWORKS[networkId].format === 'p2tr' ? 255 : 160;
  const log10ExpectedYears = addressBits * Math.log10(2) - Math.log10(candidatesPerSecond) - Math.log10(365.25 * 24 * 60 * 60);

  discreteLogResult = {
    status: 'valid', addressInput, networkId, parsed, startScalar, lastScalar: lastScalarTested,
    trials: testedCount, totalTested: lastScalarTested, elapsedMs, candidatesPerSecond, addressBits,
    log10ExpectedYears, firstCandidateAddress, lastCandidateAddress, foundScalar, foundPublicKey,
  };
  autoSearchEnabled = false;
  discreteLogProgress = null;
  render();
}


function wipeWalletSecrets() {
  wipeTaprootData();
  wallet.entropy?.fill(0);
  wallet.bip39Salt?.fill(0);
  wallet.seed?.fill(0);
  wallet.masterHmacOutput?.fill(0);
  wallet.master?.wipePrivateData();
  wallet.pathNodes.forEach((entry) => entry.node?.wipePrivateData());
  wallet.account?.wipePrivateData();
}

function resetWallet() {
  autoSearchEnabled = false;
  searchRunId += 1;
  discreteLogProgress = null;
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
